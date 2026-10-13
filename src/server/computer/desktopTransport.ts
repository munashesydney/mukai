import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { QemuComputer } from './qemuComputer';
import type { ComputerViewSession } from '../../shared/computer';
import { trustedLocalRequest } from '../web/origin';

/** Authenticated HTTP issues short-lived, single-use viewer tickets. No API token in websocket URLs. */
export class DesktopTransport {
  constructor(
    private readonly browserMode = false,
    private readonly authenticate?: (request: IncomingMessage) => boolean,
  ) {}
  private tickets = new Map<
    string,
    { computer: QemuComputer; port: number; password: string; expires: number }
  >();
  private sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  private closed = false;
  private viewers = new Map<WebSocket, QemuComputer>();
  private viewerRequests = new Map<WebSocket, IncomingMessage>();
  private authTimer = setInterval(() => {
    if (this.authenticate)
      for (const [viewer, request] of this.viewerRequests)
        if (!this.authenticate(request)) viewer.terminate();
  }, 5000).unref();
  forget(computer: QemuComputer) {
    for (const [key, ticket] of this.tickets)
      if (ticket.computer === computer) this.tickets.delete(key);
    for (const [viewer, owner] of this.viewers) if (owner === computer) viewer.terminate();
  }
  async session(computer: QemuComputer): Promise<ComputerViewSession> {
    if (this.closed) throw new Error('Desktop views are shutting down.');
    try {
      await computer.start();
    } catch (error) {
      // The VNC desktop can survive a bridge disconnect. Reuse only a live VM's
      // existing endpoint; stopped, booting and panicked guests reject it.
      try {
        computer.desktopConnection();
      } catch {
        throw error;
      }
    }
    if (this.closed) throw new Error('Desktop views are shutting down.');
    for (const [key, value] of this.tickets)
      if (value.expires <= Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 32)
      throw new Error('Too many pending desktop views. Try again shortly.');
    const connection = computer.desktopConnection();
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(ticket, { computer, ...connection, expires: Date.now() + 30000 });
    return { path: '/computer-view?ticket=' + ticket, password: connection.password };
  }
  attach(server: Server) {
    server.on('upgrade', this.upgrade);
  }
  private upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const reject = () => {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    };
    if (this.closed || !trustedLocalRequest(request, this.browserMode, true)) return reject();
    if (this.authenticate && !this.authenticate(request)) return reject();
    let url: URL;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      return reject();
    }
    const key = url.searchParams.get('ticket') || '';
    const ticket = this.tickets.get(key);
    if (
      (url.pathname !== '/computer-view' &&
        (!this.browserMode || url.pathname !== '/api/computer-view')) ||
      !ticket ||
      ticket.expires <= Date.now()
    )
      return reject();
    this.tickets.delete(key);
    try {
      const current = ticket.computer.desktopConnection();
      if (current.port !== ticket.port || current.password !== ticket.password) return reject();
    } catch {
      return reject();
    }
    if (this.sockets.clients.size >= 4) return reject();
    this.sockets.handleUpgrade(request, socket, head, (viewer) => {
      this.viewers.set(viewer, ticket.computer);
      this.viewerRequests.set(viewer, request);
      viewer.once('close', () => {
        this.viewers.delete(viewer);
        this.viewerRequests.delete(viewer);
      });
      const upstream = connect(ticket.port, '127.0.0.1');
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.once('connect', () => upstream.setTimeout(0));
      const close = () => {
        upstream.destroy();
        if (viewer.readyState === WebSocket.OPEN) viewer.close();
      };
      viewer.on('error', close);
      viewer.on('close', () => upstream.destroy());
      upstream.on('error', close);
      upstream.on('close', close);
      viewer.on('message', (data, binary) => {
        if (!binary || upstream.writableLength > 4 * 1024 * 1024) {
          viewer.close(1008, 'Invalid or excessive desktop input.');
          return;
        }
        upstream.write(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer));
      });
      upstream.on('data', (bytes) => {
        if (viewer.readyState !== WebSocket.OPEN) return;
        if (viewer.bufferedAmount > 8 * 1024 * 1024) {
          viewer.close(1008, 'Desktop connection too slow.');
          return;
        }
        viewer.send(bytes, { binary: true });
      });
    });
  };
  shutdown() {
    this.closed = true;
    clearInterval(this.authTimer);
    this.tickets.clear();
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
  }
}
