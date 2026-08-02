#!/usr/bin/env python3
"""Renders a Plotly figure to a PNG.

Reads a JSON document from stdin of the form { "figure": { ... }, "width": N, "height": N },
writes the resulting PNG bytes to stdout. Non-zero exit code + stderr message on failure.
Kaleido keeps a headless Chromium subprocess alive, so per-invocation startup is a few
hundred ms; batch-rendering multiple figures in one process would be faster if it ever
matters (currently not a hot path).
"""
import io
import json
import sys

import plotly.io as pio

# Force UTF-8 on stdin regardless of the OS locale — Python on Windows defaults to
# the console codepage, which mangles non-ASCII chars in figure titles/labels.
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"plotly_render: invalid JSON on stdin: {exc}", file=sys.stderr)
        return 2

    figure_json = payload.get("figure")
    if figure_json is None:
        print("plotly_render: missing 'figure' key in payload", file=sys.stderr)
        return 2

    width = int(payload.get("width", 800))
    height = int(payload.get("height", 500))
    scale = float(payload.get("scale", 2))

    try:
        fig = pio.from_json(json.dumps(figure_json))
        img_bytes = pio.to_image(fig, format="png", width=width, height=height, scale=scale)
    except Exception as exc:
        print(f"plotly_render: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    sys.stdout.buffer.write(img_bytes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
