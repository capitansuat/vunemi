/**
 * A small SMTP server for tests: enough of the protocol for nodemailer to
 * greet, upgrade with STARTTLS, sign in, address and send one message. Each
 * behaviour a real server might show is a switch, so the outbox can be tried
 * against refusals and dropped connections without any network.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

export interface FakeSmtpOptions {
  /** Offer STARTTLS. Without it a careful client must refuse to sign in. */
  tls?: boolean;
  password?: string;
  /** Recipients refused at RCPT TO. */
  reject?: string[];
  /** Answer the finished message with 554 instead of 250. */
  refuseMessage?: boolean;
  /** Drop the connection once the message has been read, before answering. */
  dropAfterData?: boolean;
  /** Offer XOAUTH2 and accept this bearer token. */
  accessToken?: string;
}

export interface Received {
  from: string;
  to: string[];
  data: string;
}

/** A throwaway certificate for "localhost", made with the system's openssl. */
export function makeCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "tenami-smtp-cert-"));
  try {
    execFileSync("/usr/bin/openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class FakeSmtp {
  readonly received: Received[] = [];
  /** Every sign-in attempt, successful or not: a password sent in the clear would show here. */
  readonly authAttempts: { secure: boolean }[] = [];
  private server: Server | null = null;
  port = 0;

  constructor(private readonly options: FakeSmtpOptions, private readonly credentials: { key: string; cert: string }) {}

  async start(): Promise<number> {
    this.server = createServer((socket) => this.session(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private session(raw: Socket): void {
    let socket: Socket | TLSSocket = raw;
    let secure = false;
    let authed = false;
    let buffer = "";
    let mode: "command" | "data" | "auth" = "command";
    let current: Received = { from: "", to: [], data: "" };
    const say = (line: string) => socket.write(`${line}\r\n`);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (mode === "data") {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          mode = "command";
          if (this.options.dropAfterData) {
            socket.destroy();
            return;
          }
          if (this.options.refuseMessage) {
            say("554 5.7.1 Message refused");
          } else {
            this.received.push(current);
            say("250 2.0.0 Queued");
          }
          current = { from: "", to: [], data: "" };
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (mode === "auth") {
          mode = "command";
          signIn(line);
          continue;
        }
        command(line);
        if (socket.destroyed) return;
      }
    };

    const signIn = (encoded: string) => {
      this.authAttempts.push({ secure });
      const parts = Buffer.from(encoded, "base64").toString("utf8").split("\u0000");
      if (parts[2] === (this.options.password ?? "secret")) {
        authed = true;
        say("235 2.7.0 Authenticated");
      } else {
        say("535 5.7.8 Bad credentials");
      }
    };

    const command = (line: string) => {
      const verb = line.split(" ")[0]!.toUpperCase();
      switch (verb) {
        case "EHLO":
        case "HELO": {
          const lines = ["250-fake.localhost"];
          if (this.options.tls && !secure) lines.push("250-STARTTLS");
          if (secure || !this.options.tls) lines.push(this.options.accessToken ? "250-AUTH PLAIN XOAUTH2" : "250-AUTH PLAIN");
          lines.push("250 8BITMIME");
          socket.write(`${lines.join("\r\n")}\r\n`);
          return;
        }
        case "STARTTLS": {
          if (!this.options.tls || secure) return say("502 5.5.1 Not available");
          say("220 2.0.0 Go ahead");
          socket.removeListener("data", onData);
          const upgraded = new TLSSocket(raw, { isServer: true, key: this.credentials.key, cert: this.credentials.cert });
          upgraded.on("error", () => upgraded.destroy());
          upgraded.on("data", onData);
          socket = upgraded;
          secure = true;
          return;
        }
        case "AUTH": {
          const [, method, initial] = line.split(" ");
          if (method?.toUpperCase() === "XOAUTH2" && this.options.accessToken && initial) {
            this.authAttempts.push({ secure });
            // user=<user>^Aauth=Bearer <token>^A^A
            const decoded = Buffer.from(initial, "base64").toString("utf8");
            if (decoded.includes(`auth=Bearer ${this.options.accessToken}\u0001`)) {
              authed = true;
              return say("235 2.7.0 Accepted");
            }
            return say("535 5.7.8 Username and Password not accepted");
          }
          if (method?.toUpperCase() !== "PLAIN") return say("504 5.5.4 Unsupported");
          if (initial) return signIn(initial);
          mode = "auth";
          return say("334 ");
        }
        case "MAIL":
          if (!authed) return say("530 5.7.0 Authentication required");
          current = { from: line.slice(10).replace(/[<>]/g, "").split(" ")[0]!, to: [], data: "" };
          return say("250 2.1.0 OK");
        case "RCPT": {
          const address = line.slice(8).replace(/[<>]/g, "").split(" ")[0]!;
          if (this.options.reject?.includes(address)) return say("550 5.1.1 No such user");
          current.to.push(address);
          return say("250 2.1.5 OK");
        }
        case "DATA":
          if (current.to.length === 0) return say("554 5.5.1 No valid recipients");
          mode = "data";
          return say("354 End data with <CR><LF>.<CR><LF>");
        case "RSET":
          current = { from: "", to: [], data: "" };
          return say("250 2.0.0 OK");
        case "NOOP":
          return say("250 2.0.0 OK");
        case "QUIT":
          say("221 2.0.0 Bye");
          socket.end();
          return;
        default:
          return say("502 5.5.2 Unknown command");
      }
    };

    raw.on("data", onData);
    raw.on("error", () => raw.destroy());
    say("220 fake.localhost ESMTP");
  }
}
