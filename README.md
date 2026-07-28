# Pull Request Review Queue

Chrome extension: queue of GitHub pull requests with **your** review requested. Hit **Next Pull Request** / `Alt+Shift+N` to jump to the next one.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → this folder
4. Open **Options** → paste PAT + allowlist repos (`owner/name`, one per line)

### Token

- Fine-grained: **Pull requests: Read** on the allowlisted repos

## Behavior

- Queue = `is:pr is:open review-requested:@me draft:false` in allowlist
- Order = `updated` ascending (proxy for longest waiting)
- Popup = full list; pull request pages = **Next Pull Request** button
- Empty queue → toast “Queue clear”, stay on page
