import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db/database';
import { ApiError, privateSecret } from '../config';

export class PushRepository {
  private key: Buffer;
  readonly serverId: string;
  constructor(private store: Database) {
    this.key = privateSecret(store.dir, 'push-encryption.key', 32);
    this.serverId = privateSecret(store.dir, 'push-server-id', 24).toString('hex');
  }
  private session(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, 'Mobile sign-in required.');
    const hash = createHash('sha256')
      .update('mukai-device:' + token)
      .digest('hex');
    if (
      !this.store.get(
        'SELECT token_hash FROM web_sessions WHERE token_hash=? AND expires_at>?',
        hash,
        Date.now(),
      )
    )
      throw new ApiError(401, 'Mobile sign-in required.');
    return hash;
  }
  register(
    token: string,
    input: { installationId: string; relayUrl: string; deliveryToken: string },
  ) {
    const session = this.session(token);
    if (
      Number(
        this.store.get(
          'SELECT count(*) AS n FROM mobile_push_devices WHERE session_hash=?',
          session,
        )?.n,
      ) >= 5 &&
      !this.store.get('SELECT id FROM mobile_push_devices WHERE id=?', input.installationId)
    )
      throw new ApiError(429, 'Too many devices for this session.');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([
      nonce,
      cipher.update(input.deliveryToken, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
    this.store.run(
      `INSERT INTO mobile_push_devices(id,session_hash,relay_url,credential,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET session_hash=excluded.session_hash,relay_url=excluded.relay_url,credential=excluded.credential`,
      input.installationId,
      session,
      input.relayUrl,
      encrypted,
      Date.now(),
    );
  }
  remove(token: string, id: string) {
    this.store.run(
      'DELETE FROM mobile_push_devices WHERE id=? AND session_hash=?',
      id,
      this.session(token),
    );
  }
  test(token: string) {
    const session = this.session(token);
    const devices = this.store.all(
      'SELECT id FROM mobile_push_devices WHERE session_hash=?',
      session,
    );
    if (!devices.length) throw new ApiError(409, 'Enable notifications on this phone first.');
    const conversation = this.store.get(
      "SELECT c.id,c.workspace_id,c.owner_bot_id FROM conversations c WHERE c.kind='private' ORDER BY c.updated_at DESC LIMIT 1",
    );
    if (!conversation) throw new ApiError(409, 'Create a bot conversation first.');
    for (const device of devices) {
      const id = randomUUID();
      this.store.run(
        'INSERT INTO mobile_push_outbox(id,device_id,payload,created_at,next_at) VALUES(?,?,?,?,0)',
        id,
        String(device.id),
        JSON.stringify({
          eventId: id,
          kind: 'test',
          workspaceId: String(conversation.workspace_id),
          conversationId: String(conversation.id),
          botId: String(conversation.owner_bot_id),
        }),
        Date.now(),
      );
    }
    return { queued: true };
  }
  pending() {
    this.store.run(
      'DELETE FROM mobile_push_devices WHERE session_hash NOT IN (SELECT token_hash FROM web_sessions WHERE expires_at>?)',
      Date.now(),
    );
    this.store.run('DELETE FROM mobile_push_outbox WHERE created_at<?', Date.now() - 86400_000);
    return this.store.all(
      `SELECT o.*,d.relay_url,d.credential FROM mobile_push_outbox o JOIN mobile_push_devices d ON d.id=o.device_id
      WHERE o.status='pending' AND o.next_at<=? ORDER BY o.created_at LIMIT 8`,
      Date.now(),
    );
  }
  credential(value: string) {
    const bytes = Buffer.from(value, 'base64'),
      decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
      'utf8',
    );
  }
  result(id: string, deviceId: string, status: number, attempts: number) {
    if ([401, 404, 410].includes(status)) {
      this.store.run('DELETE FROM mobile_push_devices WHERE id=?', deviceId);
    } else if (status >= 200 && status < 300) {
      this.store.run("UPDATE mobile_push_outbox SET status='sent' WHERE id=?", id);
    } else {
      this.store.run(
        'UPDATE mobile_push_outbox SET status=?,attempts=?,next_at=? WHERE id=?',
        attempts >= 10 ? 'failed' : 'pending',
        attempts,
        Date.now() + Math.min(300_000, 1000 * 2 ** attempts),
        id,
      );
    }
  }
}
