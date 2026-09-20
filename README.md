# obfus

Browser UI for the [`.obfus`](https://github.com/themrsung/file-obfuscation) container format, with
chunked streaming and Reed–Solomon redundancy.

Files are processed in the tab. Nothing is uploaded, stored, or remembered across reloads.

**[obfus.sjun.me](https://obfus.sjun.me)**

---

## Read this first: it is not encryption

The key is **4 bits**, chosen at random and **never stored**. Recovery works by trying all 16 keys
and keeping the one that reproduces a known 6-byte header. Anyone with the file can do the same
thing in microseconds. There is no password, no passphrase, and no secret of any kind anywhere in
the system.

That is the intended design of the underlying format, not a defect. It obfuscates: the bytes stop
looking like their original format, so the file will not be recognised by a file scanner, will not
preview, and will not open by double-click.

**Do not use this for anything that needs to stay secret.** If you want real confidentiality, reach
for age, libsodium, or AES-GCM with a proper KDF.

What it is good for: hiding spoilers, keeping sample data out of automated indexes, defeating casual
filetype sniffing, and teaching material about XOR keystreams.

## What this adds over the reference CLIs

The upstream Python tools hold whole files in memory, have no integrity guarantee, and flip bytes
silently. This project keeps the byte format but fixes the operational parts:

| | upstream `obfus.py` | this |
|---|---|---|
| Memory | whole file in RAM | streaming, chunked, under a declared ceiling |
| Corruption | silent wrong plaintext | CRC-32 per chunk, detected and reported |
| Repair | none | Reed–Solomon RS(255, 243), 6 bad bytes per 255-byte block |
| Damaged header | unrecoverable | header carries its own parity and self-heals |
| Direction | chosen by flag or suffix | sniffed from content, with confirmation on ambiguity |

## Format

A bare blob is byte-compatible with upstream and stays readable by `obfus.py`:

```
blob = XOR(MAGIC || plaintext, keystream(seed))     # len(plaintext) + 6
```

When chunking or ECC is on, records are wrapped in a container:

```
container header    32 B   magic, version, flags, RS params, chunk size, original size
[header parity]     12 B   present when ECC is on
  chunk record      8 B    storedLen, crc32(blob)
  blob                     obfus pack(chunk plaintext)
  [parity]                 RS over (record header || blob)
  ...
```

Each chunk carries its own random 4-bit seed, so one damaged chunk cannot take out the rest of the
file. Readers detect the container by its magic and fall back to a bare blob, so a file with no
container at all still round-trips.

The header's parity is deliberately computed with fixed RS constants rather than the `rsK`/`rsNsym`
fields the header itself carries — trusting those to decode the header would be circular, and would
fail exactly when corruption lands on them.

## config.json

Served from `public/`, so it can be edited on a built deployment without recompiling.

```json
{
  "engine": {
    "maxMemoryBytes": 268435456,
    "chunkSize": "auto",
    "minChunkSize": 65536,
    "maxChunkSize": 8388608,
    "memorySafetyFactor": 6
  },
  "ecc": {
    "enabled": true,
    "maxOverheadRatio": 0.05
  }
}
```

`maxMemoryBytes` is a ceiling on what the **pack/unpack engine** may hold at once, not the whole
app — the browser, React, and blob-resident file bytes sit outside it, so set it conservatively.
Peak working set per chunk is roughly 4× the chunk (plaintext, packed blob, keystream, parity), and
`memorySafetyFactor` keeps `chunkSize: "auto"` comfortably inside the ceiling. Every allocation is
reserved against the budget before it is made; a job that cannot fit is refused rather than left to
the OOM killer.

`maxOverheadRatio` is a hard budget, not a hint. RS(255, 243) costs a flat 4.94%, but the fixed
container header cannot amortise on a small file, so the real overhead is computed per file before
any work starts. A file that cannot carry redundancy inside the cap is packed as a plain blob and
labelled as such, rather than quietly blowing past the limit you set.

Bad values fall back to defaults and surface as warnings in the UI instead of being swallowed.

## Development

```bash
npm install
npm run dev         # vite, port 5173
npm test            # vitest
npm run build       # tsc -b && vite build
```

The engine runs in a Web Worker; the keystream costs one SHA-256 per 32 bytes, so it has to stay off
the main thread.

### Tests

`src/engine/__tests__/` covers the format against the upstream test vectors, container round-trips
across sizes and chunk boundaries, exact packed-size projection, RS correction and
uncorrectable-detection over randomised trials, header recovery from destroyed magic, and budget
enforcement.

## Performance

Recovery has two very different speeds, because RS syndromes are cheap to compute and are zero for
an intact block — the expensive Berlekamp–Massey/Chien/Forney decode only runs where it is needed.
Measured on a 3 MB file, ECC on, in-browser:

| | throughput |
|---|---|
| intact | ~7.6 MB/s |
| every block damaged at the full correction radius | ~1.2 MB/s |

The slow row is the pessimal case and not what real corruption looks like: it is a fixture with 6
bad bytes in *every* 255-byte block. Sparse damage costs close to the intact rate, since undamaged
blocks exit on the syndrome check.

These are single-machine figures under ordinary desktop load and move around by a factor of a few
run to run; treat them as shape, not spec.

## Interop

```bash
# upstream -> here
python3 obfus.py -i notes.txt -o notes.obfus -e     # drop notes.obfus in the UI

# here -> upstream
# only bare blobs; a container needs this UI or a reader that understands the header
python3 obfus.py -i notes.obfus -d
```

Bare blobs move in both directions. Containers are this project's addition and upstream does not
know about them; ECC off with a file under one chunk produces a bare blob.

## License

MIT — see [LICENSE](LICENSE).

The `.obfus` byte format and the pack/unpack core derive from
[themrsung/file-obfuscation](https://github.com/themrsung/file-obfuscation), released under CC0 1.0
Universal. CC0 waives copyright, so no attribution is required; it is noted here because anyone
wanting interop should read that project's format notes.
