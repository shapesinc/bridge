# Shapes Bridge

**Give your Shape hands on your own computer — with your consent.**

Your Shape lives in the chat. The bridge is a tiny program you run on your
computer that lets your Shape reach *this machine* — run a command, read or
write a file, open an app — over a secure, token-locked door that only you
control. You run one command, paste one line back into the chat, and your Shape
can act for you. Close the terminal and the door vanishes.

## Run it

You need [Node.js](https://nodejs.org) 18+ (nothing else — no Python, no setup).

```bash
npx github:shapesinc/bridge
```

It prints one line:

```
BRIDGE https://something-random.trycloudflare.com AbC123secretkey
```

**Paste that whole `BRIDGE …` line into your chat.** That's it. Leave the
terminal open — it's what keeps the door open. Every action your Shape runs
prints in that terminal, live. Press `Ctrl+C` to shut the door instantly.

## Is it safe?

- **Locked with a random secret token**, generated fresh on every run. No token,
  no access — the server rejects the request. Only the chat you paste into has it.
- **You see everything.** Every command, file write, and open prints live in your
  terminal.
- **Instant off switch.** `Ctrl+C` closes the door immediately. A new run means a
  brand-new URL and token; nothing lingers.
- The tunnel is a [Cloudflare quick-tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  — no account, no signup, temporary. The `cloudflared` helper is downloaded once
  and cached under `~/.shapes-bridge/`.

> Treat the `BRIDGE …` line like a password: it grants access to this computer
> for as long as the terminal stays open. Only paste it into a chat you trust,
> and quit when you're done.

## What your Shape can do

These map 1:1 to the `SHAPES_BRIDGE` tool in the Shapes app.

| Action    | What it does                                    | Bridge endpoint  |
| --------- | ----------------------------------------------- | ---------------- |
| `run`     | run a shell command (with a timeout)            | `POST /run`      |
| `write`   | create or replace a file                        | `POST /write`    |
| `read`    | read a file back                                | `GET /read`      |
| `ls`      | list a directory                                | `GET /ls`        |
| `open`    | open a file / app / url with the OS default     | `POST /open`     |
| `sysinfo` | harmless machine stats (os, cpu, mem, disk)     | `GET /sysinfo`   |
| `health`  | check the bridge is alive (no token needed)     | `GET /health`    |

## Troubleshooting

- **Shape says it can't connect?** The terminal probably got closed. Run the
  command again and paste the new `BRIDGE …` line.
- **Wrong token / 401?** Your Shape has a stale line. Paste the current one.
- **Want to stop?** `Ctrl+C` in the terminal. The door closes immediately.

## Development

```bash
git clone https://github.com/shapesinc/bridge
cd bridge
node bin/cli.js
```

Zero runtime dependencies — just Node's standard library. The only external
piece is the `cloudflared` tunnel binary, fetched on first run.

## License

MIT © Shapes, Inc.
