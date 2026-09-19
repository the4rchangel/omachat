# Omachat

Peer-to-peer community chat for [Omarchy](https://omarchy.org) — **no chat server**.

Join a named room, find peers over Hyperswarm (global), Avahi mDNS (LAN), and/or Tailscale (shared tailnet), and chat in a three-pane TUI.

![Omachat lobby — rooms, chat, people](assets/omachat-lobby.png)

## How it works

| Layer | When it helps | Needs port forward? |
|-------|----------------|---------------------|
| **Hyperswarm / HyperDHT** | Anywhere on the internet (UDP + holepunch) | **No** — do not forward ports for this |
| **mDNS (Avahi)** | Same LAN — direct TCP on **4177** | No — LAN only; forwarding does nothing useful |
| **Tailscale** | Shared tailnet — probes TCP **4177** | No — Tailscale is the tunnel |

Same room name = same topic. There is no Omarchy-operated chat server and no message history when you are offline.

### Reachability (are you findable from the internet?)

**TCP 4177 is not your “public chat port.”** It is only for LAN mDNS and Tailscale shortcuts (cleartext). Strangers on the internet do **not** connect to it, and Omachat has no “enter my IP:4177” mode. Forwarding 4177 to the world exposes an unauthenticated cleartext listener — **don’t**.

Global reachability goes through **Hyperswarm**:

1. Both peers announce the same room topic on the public HyperDHT.
2. They try a **direct UDP holepunch** (and Hyperswarm’s usual fallbacks). That uses ephemeral/local UDP, not a fixed forwarded TCP port.
3. If holepunch fails (some corporate/symmetric NATs), peers may still connect via slower relay-style paths Hyperswarm provides — or they may never meet.

**How to know it works from outside your network**

| Check | Meaning |
|-------|---------|
| Status shows `dht` / `/disco` says hyperswarm `topic announced` | You registered on the DHT. **Not** proof that someone else can open a stream to you. |
| Peer count goes from `0p` → `1p+` when a friend joins `#lobby` from another network | **This** is the real test. |
| Friend never appears after ~30s on a normal home connection | DHT blocked, hostile NAT, or they joined a different room name. |

Practical test: phone hotspot or a friend’s home PC, same room (`lobby`), both online at the same time. If you see each other, you’re reachable enough for Omachat’s global path — no router port map required.

## Requirements

- **Node.js ≥ 20**
- **gum** (launcher splash / nick picker)
- Optional: **Avahi** (`avahi-publish`, `avahi-browse`), **Tailscale**

## Install

```bash
git clone https://github.com/the4rchangel/omachat.git
cd omachat
npm install
install -Dm755 bin/omachat ~/.local/bin/omachat
mkdir -p ~/.local/share/applications
cp applications/Omachat.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications 2>/dev/null || true
```

On Omarchy, the desktop entry uses `omarchy-launch-or-focus-tui` so it shows up in the app menu like other TUIs.

## Background service (tray)

Keep Omachat online without a terminal window — same idea as Tailscale/Remmina sitting in the Omarchy top-bar tray.

```bash
omachat service install    # systemd --user daemon + Ayatana tray icon
omachat service status
omachat service stop       # or: Quit from the tray menu
omachat service uninstall
```

What you get:

| Piece | Role |
|-------|------|
| `omachat.service` | Headless daemon — stays joined to lobby/ideas/help/ai, encrypted history, desktop notifications |
| `omachat-tray.service` | Tray icon in Omarchy’s SystemTray — Open chat, notify mode, Quit daemon |
| TUI attach | `omachat` / app menu opens the window against the daemon; **closing the window leaves you online** |

Notifications use `omarchy-notification-send`. Tray menu can switch all-room / mentions-only / off.

Requires: `python-gobject`, `libayatana-appindicator` (already common on Omarchy).

## Run

```bash
omachat                 # gum splash → nick (first run) → #lobby
omachat ideas           # open #ideas
node src/cli.js --nick YourName lobby
```

Two local peers (separate identities):

```bash
node src/cli.js --nick Alice lobby
# other terminal:
OMACHAT_CONFIG=/tmp/omachat-bob OMACHAT_PORT=4178 node src/cli.js --nick Bob lobby
```

## Layout & keys

```
 rooms     │ #lobby              │ people
>#lobby    │ 01:12  alice  hi    │ alice (you)
 #ideas    │ 01:13  bob    yo    │ bob
 #help     │                     │
 #ai       │                     │
omachat #lobby · 1p · alice · dht+mdns:4177
> message here
```

| Key | Action |
|-----|--------|
| Type + **Enter** | Send message |
| **Enter** (empty) | Open highlighted room |
| **Ctrl+N** / **Ctrl+P** | Next / previous room |
| **F1**–**F4** | Jump lobby / ideas / help / ai |
| **↑** / **↓** | Move room highlight |
| `/join name` | Switch or create a room |
| `/peers` | List connected peers |
| `/disco` | Discovery status |
| `/nick` | Change nick |
| `/help` | Commands |
| **Ctrl+C** | Quit |

## Config & environment

```
~/.config/omachat/nick
~/.config/omachat/identity.seed   # keep private (mode 0600)
~/.config/omachat/history/*.bin   # AES-GCM encrypted per-room logs (mode 0600)
~/.config/omachat/tui-error.log   # only if the TUI throws
```

| Env | Meaning |
|-----|---------|
| `OMACHAT_CONFIG` | Override config directory |
| `OMACHAT_HOME` | Override install root (where `src/cli.js` lives) |
| `OMACHAT_PORT` | Direct listen port (default `4177`) |
| `OMACHAT_NO_MDNS=1` | Disable Avahi |
| `OMACHAT_NO_TAILSCALE=1` | Disable Tailscale probing |

## Local history (while you are online)

There is still **no chat server**, so offline peers cannot fetch what they missed on the network. What Omachat *does* store is **your client’s view**:

- While the app is running, you stay joined to **#lobby, #ideas, #help, and #ai** (plus any `/join` rooms). Switching panes only changes focus — it does not leave the other rooms.
- Messages from background rooms are captured; unread counts show on the room list.
- Chat is written under `~/.config/omachat/history/` encrypted with **AES-256-GCM**. The key is derived from your `identity.seed` (HKDF). Files are mode `0600`.
- Restarting the app reloads that local history into each room pane.

This is disk encryption at rest on your machine — not E2E against a malicious peer, and not a shared backlog for the whole swarm.

## Security

- **No chat server.** Discovery uses public HyperDHT bootstraps; chat is peer-to-peer.
- **Hyperswarm** paths use Noise encryption.
- **Direct TCP** (mDNS / Tailscale) is cleartext JSON — intended for trusted LAN / tailnet. Do not port-forward **4177** to the public internet.
- **Room name = invite** for v1. Anyone who knows the room name can join that topic.
- **Local history** is encrypted at rest with a key derived from `identity.seed`. Losing the seed means you cannot decrypt old `history/*.bin` files. Do not commit or share the seed.
- Legacy Libera IRC launcher (if present): `bin/omachat-irc`.

## Tests

```bash
npm test                 # smoke + TUI keys + encrypted history
npm run smoke
npm run keys
npm run history
```

## Troubleshooting

### `omachat: command not found`

The launcher is not on your `PATH`.

```bash
install -Dm755 bin/omachat ~/.local/bin/omachat
# ensure ~/.local/bin is on PATH (Omarchy usually has this)
echo "$PATH" | tr ':' '\n' | grep -q "$HOME/.local/bin" || echo 'Add export PATH="$HOME/.local/bin:$PATH" to your shell rc'
```

### `Cannot find Omachat app`

The launcher cannot locate `src/cli.js`.

```bash
export OMACHAT_HOME=~/Projects/omachat   # or wherever you cloned
omachat
```

Or reinstall the launcher from that clone so it resolves relative to the repo.

### Window opens then immediately closes / blank terminal

Usually a Node crash. Run without the gum wrapper:

```bash
cd ~/path/to/omachat
node src/cli.js --nick TestUser lobby
```

Check:

```bash
node -v                    # need >= 20
cat ~/.config/omachat/tui-error.log 2>/dev/null
```

If `tui-error.log` exists, the stack trace there is the starting point.

### Typing does nothing / keys feel wrong

Fully quit (**Ctrl+C**) and relaunch — do not reuse a half-dead terminal session. Omachat uses raw mode; a previous crash can leave the terminal in a bad state:

```bash
reset
omachat
```

### Stuck at `0p` / `searching...` (no peers)

You are alone until another peer joins the **same room** with a working discovery path.

1. Confirm the other person is in the same room (`#lobby` vs `#ideas` are different topics).
2. Check discovery: type `/disco` in the TUI.
3. **Same machine test:** run a second peer with a different config and port (see [Run](#run)).
4. **LAN:** ensure Avahi is running (`systemctl status avahi-daemon`). Disable with `OMACHAT_NO_MDNS=1` if it misbehaves.
5. **Internet:** Hyperswarm needs **outbound** UDP to public DHT/bootstrap nodes. Corporate / captive portals often block this — try a normal home network or phone hotspot. You do **not** need to forward TCP 4177 (see [Reachability](#reachability-are-you-findable-from-the-internet)).
6. **Tailscale:** both peers must be on the same tailnet; status should mention `ts` when probing works. Skip with `OMACHAT_NO_TAILSCALE=1` if Tailscale is installed but unused.
7. Wait 10–30 seconds after join; DHT announcements are not instant.

### Do I need to forward port 4177?

**No** for chatting with people on the public internet. That path is Hyperswarm (DHT + UDP holepunch), not inbound TCP to 4177.

Forwarding 4177:

- Does **not** make Hyperswarm “more reachable.”
- Does **not** help mDNS (multicast stays on your LAN).
- Only makes the cleartext direct listener visible on your WAN IP — which Omachat peers never look up by public IP anyway.

Use Tailscale (or stay on LAN) if you want the direct-TCP shortcut across sites. Leave consumer router port forwarding alone.

### Port already in use (`EADDRINUSE` / listen fails)

Something else is bound near **4177**.

```bash
OMACHAT_PORT=4180 omachat
# or
ss -ltnp | grep 4177
```

### Gum errors on launch

Install gum (Omarchy usually has it):

```bash
# Arch / Omarchy
omarchy pkg add gum   # or: pacman -S gum
```

You can always skip the launcher and run `node src/cli.js --nick YourName lobby`.

### Desktop entry does nothing

- Confirm `omachat` works in a terminal first.
- On non-Omarchy systems, edit `Exec=` in the `.desktop` file to call a terminal, e.g. `Exec=alacritty -e omachat`, or install Omarchy’s TUI launch helpers.
- Refresh: `update-desktop-database ~/.local/share/applications`

### `npm install` / native module build failures

Hyperswarm pulls native addons (`sodium-native`, `udx-native`). Install build tools:

```bash
# Arch
sudo pacman -S base-devel python
node -v   # >= 20
rm -rf node_modules && npm install
```

### Privacy checklist after a shared machine

```bash
ls -la ~/.config/omachat/
# identity.seed should be -rw------- (0600)
chmod 600 ~/.config/omachat/identity.seed 2>/dev/null
```

## Upstream (Omarchy)

Packaging into Omarchy itself is a separate process (Suggestion discussion, then a thin install/desktop PR). See [`UPSTREAM.md`](UPSTREAM.md).

## License

MIT
