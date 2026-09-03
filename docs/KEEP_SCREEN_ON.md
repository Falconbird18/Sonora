# Keep screen on while viewing scores

## Already on branch `feature/smooth-viewer-polish`
- `src/lib/wakeLock.ts` — Screen Wake Lock helper (committed)

## Important: restore ScoreViewer first

`src/lib/ScoreViewer.svelte` on this branch was truncated during a large-file upload. Restore it:

```bash
git checkout 5b1f938e4940473cc15c9e4d5ec632eed438d445 -- src/lib/ScoreViewer.svelte
```

Then apply the keep-awake wiring below (or ask the agent to re-push the full file once restored).

### 1. Import

```ts
import {
  acquireScreenWakeLock,
  releaseScreenWakeLock
} from './wakeLock';
```

### 2. State

```ts
let keepAwake = $state(true);
let wakeLockActive = $state(false);
```

### 3. Helpers

```ts
async function requestWakeLock() {
  if (!keepAwake || closed) {
    wakeLockActive = false;
    return;
  }
  const ok = await acquireScreenWakeLock();
  wakeLockActive = ok;
}

async function releaseWakeLock() {
  await releaseScreenWakeLock();
  wakeLockActive = false;
}
```

### 4. onMount

After loading prefs:

```ts
keepAwake = saved.keepAwake !== false;
```

After `void load()`:

```ts
void requestWakeLock();
const onVisibility = () => {
  if (document.visibilityState === 'visible') void requestWakeLock();
  else void releaseWakeLock();
};
document.addEventListener('visibilitychange', onVisibility);
```

In the cleanup return:

```ts
document.removeEventListener('visibilitychange', onVisibility);
void releaseWakeLock();
```

### 5. leave()

```ts
await releaseWakeLock();
```

before flushing annotations.

### 6. persistPrefs

Include `keepAwake` in the saved JSON.

### 7. Settings UI

```svelte
<label class="settings-row">
  <span>
    <span class="label-title">Keep screen on</span>
    <span class="label-desc">{wakeLockActive
      ? 'Screen will stay awake while viewing'
      : 'Prevents the display from sleeping while a score is open'}</span>
  </span>
  <input
    type="checkbox"
    bind:checked={keepAwake}
    onchange={() => {
      persistPrefs();
      if (keepAwake) void requestWakeLock();
      else void releaseWakeLock();
    }}
  />
</label>
```

## Behavior

- Uses the **Screen Wake Lock API** (Chrome, Edge, Safari 16.4+, Android Chrome; works in many Tauri WebViews).
- Acquires when the score viewer opens; re-acquires when the tab becomes visible again.
- Releases when you leave the viewer, hide the tab, or turn the setting off.
- Default: **on**. Preference is persisted.
- Fails silently if unsupported or blocked (e.g. low-power mode).
