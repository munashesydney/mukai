import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { QemuComputer } from './qemuComputer';
import type { ComputerViewSession } from '../../shared/computer';
import { trustedLocalRequest, nativeClientRequest } from '../web/origin';
import type { DiagnosticService } from '../services/diagnosticService';
import { relayDesktopStream } from './desktopStream';

/** Authenticated HTTP issues short-lived, single-use viewer tickets. No API token in websocket URLs. */
export class DesktopTransport {
  constructor(
    private readonly browserMode = false,
    private readonly authenticate?: (request: IncomingMessage) => boolean,
    private readonly diagnostics?: DiagnosticService,
  ) {}
  private tickets = new Map<
    string,
    { computer: QemuComputer; port: number; password: string; expires: number; native: boolean }
  >();
  private sockets = new WebSocketServer({
    noServer: true,
    // Leave room for RFB headers and extended clipboard encoding around 1 MiB of text.
    maxPayload: 2 * 1024 * 1024,
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
  async session(
    computer: QemuComputer,
    native = false,
    reconnect = false,
  ): Promise<ComputerViewSession> {
    if (this.closed) throw new Error('Desktop views are shutting down.');
    if (!reconnect) {
      try {
        await computer.start();
      } catch (error) {
        // A live VNC desktop can survive a guest bridge disconnect.
        try {
          computer.desktopConnection();
        } catch {
          throw error;
        }
      }
    }
    // Automatic viewer recovery must never boot a stopped or failed VM.
    if (this.closed) throw new Error('Desktop views are shutting down.');
    for (const [key, value] of this.tickets)
      if (value.expires <= Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 32)
      throw new Error('Too many pending desktop views. Try again shortly.');
    const connection = computer.desktopConnection();
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(ticket, { computer, ...connection, expires: Date.now() + 30000, native });
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
    if (this.closed) return reject();
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
    const native = ticket.native && nativeClientRequest(request);
    if (!native && !trustedLocalRequest(request, this.browserMode, true)) return reject();
    if (!native && this.authenticate && !this.authenticate(request)) return reject();
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
      // Native tickets were issued by bearer-authenticated HTTP, not a revocable cookie.
      if (!native) this.viewerRequests.set(viewer, request);
      viewer.once('close', () => {
        this.viewers.delete(viewer);
        this.viewerRequests.delete(viewer);
      });
      const upstream = connect(ticket.port, '127.0.0.1');
      upstream.setNoDelay(true);
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.once('connect', () => upstream.setTimeout(0));
      relayDesktopStream(viewer, upstream, (reason, roundTripMs, bufferedBytes) => {
        this.diagnostics?.info(
          'computer.viewer_recovery',
          `Refreshing desktop stream: ${reason}; roundTripMs=${roundTripMs}; bufferedBytes=${bufferedBytes}.`,
          { phase: 'computer' },
        );
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
