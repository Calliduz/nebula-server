# KissKH Subtitle Decryption — Key Rotation Guide

KissKH encrypts subtitle files (`.txt`, `.txt1`) using AES-128-CBC. The decryption keys are embedded in KissKH's JavaScript bundles and may rotate when they push new builds.

## How It Works

```
Browser → /api/proxy/subtitle?url=https://sub.kisskh.co/.../file.txt1
                ↓
        Server detects "kisskh" in URL
                ↓
        Fetches raw encrypted file
                ↓
        Reads keys from data/kisskh-keys.json
                ↓
        Picks method by file extension (.txt → a1, .txt1 → a2, other → a3)
                ↓
        AES-CBC decrypt each subtitle cue
                ↓
        Returns clean WebVTT to player
```

## Key File Location

```
nebula-server/data/kisskh-keys.json
```

## Key File Format

```json
{
  "a1": {
    "key": "8056483646328763",
    "iv": "6852612370185273",
    "ivFormat": "utf8"
  },
  "a2": {
    "key": "AmSmZVcH93UQUezi",
    "iv": "eyJpdiI6eyJ3b3Jkcy...base64 string...",
    "ivFormat": "wordarray"
  },
  "a3": {
    "key": "sWODXX04QRTkHdlZ",
    "iv": "eyJpdiI6eyJ3b3Jkcy...base64 string...",
    "ivFormat": "wordarray"
  },
  "extensionMap": {
    ".txt": "a1",
    ".txt1": "a2",
    "default": "a3"
  }
}
```

### Two IV Formats

| `ivFormat`  | Meaning                                             | Example                            |
| ----------- | --------------------------------------------------- | ---------------------------------- |
| `utf8`      | Plain 16-character ASCII string                     | `6852612370185273`                 |
| `wordarray` | Base64-encoded JSON containing a CryptoJS WordArray | `eyJpdiI6eyJ3b3JkcyI6Wy4uLl19fQ==` |

The `wordarray` format decodes to JSON like:

```json
{
  "iv": {
    "words": [1382367819, 1465333859, 1902406224, 1164854838],
    "sigBytes": 16
  }
}
```

## How to Rotate Keys

### When to rotate

Subtitles will show as garbled text or fail silently. The server logs will show:

```
[KISSKH/DECRYPT] ⚠ Decryption failed for line: <base64 string>
```

### Step 1: Extract the new keys

1.  Open https://kisskh.co in Chrome
2.  Navigate to any drama episode
3.  Open DevTools → Console
4.  Type (function findHiddenArray() {
    console.log("Searching for internal \_$\_7270 array...");

        // 1. We look at the actual function code to confirm variable names
        const funcSource = _a2.toString();
        console.log("Internal function name:", _a2.name);

        // 2. Since we can't access closure variables directly from outside,
        // we use the debugger to 'break' into the function's scope.
        console.log("%cACTION REQUIRED:", "color: yellow; font-weight: bold;");
        console.log("1. I am setting a 'debug' point on the decryption function.");
        console.log("2. GO TO THE VIDEO PLAYER AND CLICK PLAY (or change subtitles).");
        console.log("3. The browser will PAUSE. When it does, type this in the console:");
        console.log("%c    console.table(_$_7270)", "color: cyan; font-weight: bold;");

        debug(_a2);

    })();

5.  The array will display. The keys are at these indices:

| Index  | Purpose                  |
| ------ | ------------------------ |
| **5**  | a2 IV (Base64 WordArray) |
| **10** | a2 Key (UTF-8 string)    |
| **14** | a3 IV (Base64 WordArray) |
| **15** | a3 Key (UTF-8 string)    |

> **Note:** If `_$_7270` is not defined, it means the script hasn't loaded yet. Click Play or select a subtitle track to trigger the lazy-loaded module, then try again.

### Step 2: Update the key file

SSH into the server and edit:

```bash
nano /path/to/nebula-server/data/kisskh-keys.json
```

Replace the `key` and `iv` values for the affected methods.

### Step 3: Restart

```bash
pm2 restart nebula-server
# or
systemctl restart nebula-server
```

The server reloads the key file on startup. No rebuild needed.

## Quick Validation

Test decryption directly:

```bash
curl "https://your-server/api/proxy/subtitle?url=https://sub.kisskh.co/Subtitles/some-file.txt1"
```

If the output is readable subtitle text with `WEBVTT` header, the keys are correct.

## Troubleshooting

| Symptom                     | Cause                    | Fix                                         |
| --------------------------- | ------------------------ | ------------------------------------------- |
| Garbled/empty subtitles     | Keys rotated             | Follow rotation steps above                 |
| `WEBVTT` header but no cues | Wrong method (a1 vs a2)  | Check file extension matches `extensionMap` |
| 403 on subtitle URL         | KissKH API token expired | Unrelated to keys — check `kisskhToken.js`  |
| Subtitles out of sync       | Normal variance          | Use ±0.5s adjuster in the player UI         |
