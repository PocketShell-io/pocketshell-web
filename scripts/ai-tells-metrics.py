#!/usr/bin/python3
from PIL import Image
import numpy as np, os, glob

base = '/home/alexey/git/pocketshell-web/public/images'
paths = sorted(glob.glob(base + '/blog/*.png')) + [base + '/landing-agents.png', base + '/og-cover.png']
print(f"{'image':38s} {'uniq':>7s} {'flat%':>6s} {'smooth%':>7s} {'mid%':>6s} {'edge%':>6s} {'top8%':>6s} {'bright%':>7s} {'ent':>5s}")
for p in paths:
    im = Image.open(p).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    f = a.reshape(-1, 3)
    packed = (f[:, 0].astype(np.uint32) << 16) | (f[:, 1].astype(np.uint32) << 8) | f[:, 2]
    uniq = len(np.unique(packed))
    gx = np.abs(np.diff(a, axis=1)).max(axis=2)
    gy = np.abs(np.diff(a, axis=0)).max(axis=2)
    g = np.concatenate([gx.ravel(), gy.ravel()]).astype(np.float64)
    flat = (g == 0).mean() * 100
    smooth = ((g >= 1) & (g <= 8)).mean() * 100
    mid = ((g >= 9) & (g <= 30)).mean() * 100
    edge = (g > 30).mean() * 100
    q = (f >> 4)
    qp = (q[:, 0].astype(np.uint32) << 8) | (q[:, 1].astype(np.uint32) << 4) | q[:, 2]
    vals, counts = np.unique(qp, return_counts=True)
    top8 = np.sort(counts)[::-1][:8].sum() / len(qp) * 100
    bright = (f.min(axis=1) >= 240).mean() * 100
    small = im.resize((im.width // 2, im.height // 2))
    try: ent = small.entropy()
    except Exception: ent = -1
    print(f"{os.path.basename(p):38s} {uniq:7d} {flat:6.1f} {smooth:7.2f} {mid:6.2f} {edge:6.2f} {top8:6.1f} {bright:7.3f} {ent:5.2f}")
