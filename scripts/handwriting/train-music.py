"""Train the bundled small classifier. Requires only numpy; inference uses TypeScript.

Run the adjacent export-features.mjs first. Source data is not bundled with Sonora.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('features', type=Path)
parser.add_argument('--output', type=Path, default=Path('public/handwriting'))
args = parser.parse_args()
meta = json.loads((args.features / 'samples.json').read_text())
x = np.fromfile(args.features / 'features.bin', dtype='<f4').reshape(-1, 770)
classes = sorted({row['label'] for row in meta})
y = np.array([classes.index(row['label']) for row in meta])
training = np.array([i for i, row in enumerate(meta) if row['writer'] <= 80])
testing = np.array([i for i, row in enumerate(meta) if row['writer'] > 80])
rng = np.random.default_rng(42)
indices = rng.permutation(len(training))
validation, train = training[indices[:len(training)//8]], training[indices[len(training)//8:]]
mean = x[train].mean(0)
std = x[train].std(0).clip(.015)
x = (x - mean) / std
weights = [(rng.standard_normal((770, 256)) * .045).astype('float32'), np.zeros(256, 'float32'),
           (rng.standard_normal((256, len(classes))) * .1).astype('float32'), np.zeros(len(classes), 'float32')]
m = [np.zeros_like(w) for w in weights]
v = [np.zeros_like(w) for w in weights]
step = 0
best = -1
stale = 0
best_weights = None
start = time.perf_counter()
for epoch in range(100):
    for ids in np.array_split(rng.permutation(train), max(1, len(train)//256)):
        a = x[ids]
        h = np.maximum(0, a @ weights[0] + weights[1])
        logits = h @ weights[2] + weights[3]
        logits -= logits.max(1, keepdims=True)
        p = np.exp(logits)
        p /= p.sum(1, keepdims=True)
        p[np.arange(len(ids)), y[ids]] -= 1
        p /= len(ids)
        dh = (p @ weights[2].T) * (h > 0)
        gradients = [a.T @ dh + .0001 * weights[0], dh.sum(0), h.T @ p + .0001 * weights[2], p.sum(0)]
        step += 1
        for i in range(4):
            m[i] = .9*m[i] + .1*gradients[i]
            v[i] = .999*v[i] + .001*gradients[i]**2
            weights[i] -= .001*(m[i]/(1-.9**step))/(np.sqrt(v[i]/(1-.999**step))+1e-8)
    predictions = np.argmax(np.maximum(0, x[validation] @ weights[0] + weights[1]) @ weights[2] + weights[3], 1)
    accuracy = float(np.mean(predictions == y[validation]))
    if accuracy > best:
        best, stale, best_weights = accuracy, 0, [w.copy() for w in weights]
    else:
        stale += 1
    if epoch % 10 == 0:
        print(json.dumps({'epoch': epoch, 'validation_accuracy': accuracy}), flush=True)
    if stale >= 12:
        break
weights = best_weights
raw = np.concatenate([mean, std, *[w.ravel() for w in weights]]).astype('<f4').tobytes()
args.output.mkdir(parents=True, exist_ok=True)
(args.output/'music-mlp.bin').write_bytes(raw)
manifest = {'version': 3, 'features': 770, 'hidden': 256, 'classes': classes, 'threshold': .98,
            'preprocessing': 'src/lib/recognition/musicClassifier.ts: musicFeatures',
            'sources': ['https://github.com/apacha/Homus', 'Hershey public-domain stroke fonts'],
            'trainingWriters': 'HOMUS 1-80 plus 4000 synthetic text rejects; random 12.5% validation',
            'evaluationWriters': 'HOMUS 81-100 plus 1000 separately generated text rejects',
            'sha256': hashlib.sha256(raw).hexdigest()}
(args.output/'music-mlp.json').write_text(json.dumps(manifest, indent=2)+'\n')
logits = np.maximum(0, x[testing] @ weights[0] + weights[1]) @ weights[2] + weights[3]
p = np.exp(logits-logits.max(1, keepdims=True))
p /= p.sum(1, keepdims=True)
predictions, confidence = p.argmax(1), p.max(1)
report = {'seed': 42, 'bytes': len(raw), 'validation_accuracy': best,
          'training_seconds': time.perf_counter()-start, 'groups': {}}
for name, group in [('music', np.array([meta[i]['writer'] <= 100 for i in testing])),
                    ('synthetic_text_rejects', np.array([meta[i]['writer'] == 101 for i in testing]))]:
    accepted = group & (confidence >= .98)
    report['groups'][name] = {'samples': int(group.sum()),
        'accuracy': float(np.mean(predictions[group] == y[testing][group])),
        'accepted_fraction': float(accepted.sum()/group.sum()),
        'accepted_precision': float(np.mean(predictions[accepted] == y[testing][accepted])) if accepted.any() else None}
(args.output/'music-training-report.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
