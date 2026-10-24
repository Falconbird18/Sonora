# Built-in handwriting recognizers

- `text-int8.onnx` (4,812,573 bytes) and `src/lib/recognition/textPreprocess.ts`:
  AccuScan by Shashank Yadav, MIT, upstream commit
  `faf7bdf130f70165234911d40dde5aa37e503ce0`.
  Source: https://github.com/shashank11yadav/AccuScan
  License: `AccuScan-LICENSE.txt`.
  Training data includes GNHK (A. W. C. Lee, J. Chung, M. Lee,
  “GNHK: A Dataset for English Handwriting in the Wild”, ICDAR 2021,
  CC BY 4.0, https://github.com/GoodNotes/GNHK-dataset) and synthetic lines
  rendered with SIL Open Font License handwriting fonts. See the upstream
  model card for the original training sources and evaluation limits.
- `music-mlp.bin`: trained for Sonora from the corrected HOMUS pen strokes,
  source https://github.com/apacha/Homus at commit
  `c812146da2dc12921f474fe6181009d5c83521ea`, and synthetic text rejects from
  public-domain Hershey stroke fonts (see `Hershey-NOTICE.txt`).
  Citation: J. Calvo-Zaragoza and J. Oncina, “Recognition of Pen-Based Music
  Notation: The HOMUS Dataset”, ICPR 2014, pp. 3038–3043,
  DOI: 10.1109/ICPR.2014.524. Corrected dataset maintained by Alexander Pacha.
  Only learned weights are distributed, not the source handwriting samples.
  Manifest and evaluation: `music-mlp.json`, `music-training-report.json`.
- ONNX Runtime by Microsoft is MIT licensed. See `ONNX-Runtime-LICENSE.txt`.

All inference runs on the device. The text model supports printable ASCII;
this is not a full-score optical music recognition system. The classifier's
closed-set evaluation does not guarantee accuracy on arbitrary handwriting.
