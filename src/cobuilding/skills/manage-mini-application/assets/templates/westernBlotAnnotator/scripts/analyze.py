"""
GelGenie-based western blot analysis pipeline.
Input: path to a PNG image
Output: JSON with membranes, lanes, bands, and the mask image path.

Steps:
  1. Load image, auto-invert if needed
  2. Run GelGenie segmentation (TorchScript model)
  3. Connected component labeling → individual bands
  4. Group components into membranes by y-gap
  5. Derive lane x-positions per membrane via column projection peaks
  6. Group components into band rows per membrane by y-proximity
"""

import sys, json, math
import numpy as np
from PIL import Image
import torch
from scipy import ndimage
from scipy.signal import find_peaks

import os
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_APP_DIR = os.path.dirname(_SCRIPT_DIR)
# Downloaded by setup/download_model.sh at app scaffold time.
# (mattaq/GelGenie-Universal-FineTune-May-2024 on HuggingFace.)
MODEL_PATH = os.path.join(_APP_DIR, "models", "unet_dec_21_finetune_epoch_590.pt")
MIN_COMPONENT_AREA = 20       # ignore tiny noise
MEMBRANE_GAP_THRESHOLD = 80   # px y-gap to split membranes
BAND_ROW_MERGE_THRESHOLD = 15 # px y-gap to merge into same band row
LANE_PEAK_MIN_DISTANCE = 30   # px min distance between lane peaks


def run(image_path: str, output_dir: str):
    # Load model
    model = torch.jit.load(MODEL_PATH, map_location="cpu")
    model.eval()

    # Load image
    img = Image.open(image_path).convert("L")
    arr = np.array(img, dtype=np.float32) / 255.0
    h, w = arr.shape

    # Auto-detect inversion: if mean > 0.5, bands are dark-on-light → invert
    needs_inversion = arr.mean() > 0.5
    input_arr = 1.0 - arr if needs_inversion else arr

    # Pad to multiples of 32 for UNet
    ph, pw = math.ceil(h / 32) * 32, math.ceil(w / 32) * 32
    padded = np.zeros((ph, pw), dtype=np.float32)
    padded[:h, :w] = input_arr

    # Inference
    tensor = torch.from_numpy(padded).unsqueeze(0).unsqueeze(0)
    with torch.no_grad():
        out = model(tensor)
    mask = torch.argmax(out, dim=1).squeeze().numpy()[:h, :w].astype(np.uint8)

    # Save mask
    mask_path = f"{output_dir}/gelgenie_mask.png"
    Image.fromarray((mask * 255).astype(np.uint8)).save(mask_path)

    # Connected components
    labeled, num_features = ndimage.label(mask)

    components = []
    for i in range(1, num_features + 1):
        ys, xs = np.where(labeled == i)
        area = len(ys)
        if area < MIN_COMPONENT_AREA:
            continue
        components.append({
            "id": int(i),
            "yMin": int(ys.min()), "yMax": int(ys.max()),
            "xMin": int(xs.min()), "xMax": int(xs.max()),
            "yCen": int(ys.mean()), "xCen": int(xs.mean()),
            "area": int(area),
        })

    if not components:
        raise RuntimeError("No bands detected in the image.")

    # Sort by y-center
    components.sort(key=lambda c: c["yCen"])

    # Group into membranes by y-gap
    membrane_groups = [[components[0]]]
    for c in components[1:]:
        if c["yMin"] - membrane_groups[-1][-1]["yMax"] > MEMBRANE_GAP_THRESHOLD:
            membrane_groups.append([c])
        else:
            membrane_groups[-1].append(c)

    # Build output
    membranes = []
    for mi, mem_comps in enumerate(membrane_groups):
        yMin = min(c["yMin"] for c in mem_comps)
        yMax = max(c["yMax"] for c in mem_comps)

        # Lane detection: group components by x-center proximity, then
        # use the midpoint of each group's x-extent as the lane center.
        x_sorted = sorted(mem_comps, key=lambda c: c["xCen"])
        lane_groups = [[x_sorted[0]]]
        for c in x_sorted[1:]:
            if c["xCen"] - lane_groups[-1][-1]["xCen"] > LANE_PEAK_MIN_DISTANCE:
                lane_groups.append([c])
            else:
                lane_groups[-1].append(c)

        lane_x_positions = []
        for grp in lane_groups:
            # Use median of component x-centers (robust to outliers)
            x_centers = [c["xCen"] for c in grp]
            lane_x_positions.append(int(np.median(x_centers)))

        # Auto-fill empty lanes: if a gap between consecutive lanes is
        # significantly larger than the median spacing, insert lanes.
        if len(lane_x_positions) >= 3:
            gaps = [lane_x_positions[i+1] - lane_x_positions[i]
                    for i in range(len(lane_x_positions) - 1)]
            median_gap = float(np.median(gaps))
            if median_gap > 0:
                filled = [lane_x_positions[0]]
                for i in range(len(lane_x_positions) - 1):
                    gap = lane_x_positions[i+1] - lane_x_positions[i]
                    n_missing = round(gap / median_gap) - 1
                    if n_missing > 0:
                        step = gap / (n_missing + 1)
                        for k in range(1, n_missing + 1):
                            filled.append(int(lane_x_positions[i] + step * k))
                    filled.append(lane_x_positions[i+1])
                lane_x_positions = filled

        # Band rows: group membrane components by y-center proximity
        sorted_comps = sorted(mem_comps, key=lambda c: c["yCen"])
        band_rows = [[sorted_comps[0]]]
        for c in sorted_comps[1:]:
            if c["yCen"] - band_rows[-1][-1]["yCen"] > BAND_ROW_MERGE_THRESHOLD:
                band_rows.append([c])
            else:
                band_rows[-1].append(c)

        bands = []
        for bi, row in enumerate(band_rows):
            avg_y = int(np.mean([c["yCen"] for c in row]))
            y_min = min(c["yMin"] for c in row)
            y_max = max(c["yMax"] for c in row)
            bands.append({
                "yCenter": avg_y,
                "yMin": y_min,
                "yMax": y_max,
                "componentCount": len(row),
            })

        # Content x-bounds from component bounding boxes
        content_xMin = max(0, min(c["xMin"] for c in mem_comps) - 10)
        content_xMax = min(w, max(c["xMax"] for c in mem_comps) + 10)

        membranes.append({
            "yStart": int(yMin),
            "yEnd": int(yMax),
            "contentXMin": int(content_xMin),
            "contentXMax": int(content_xMax),
            "laneXPositions": lane_x_positions,
            "laneCount": len(lane_x_positions),
            "bands": bands,
        })

    # ── Generate bounding box visualization ──────────────────────────────────
    from PIL import ImageDraw, ImageFont

    vis = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(vis)

    # Colors per membrane (cycling)
    MEMBRANE_COLORS = [
        (255, 80, 80),    # red
        (80, 160, 255),   # blue
        (80, 200, 80),    # green
        (255, 180, 40),   # orange
        (200, 80, 255),   # purple
    ]

    for mi, mem_comps in enumerate(membrane_groups):
        color = MEMBRANE_COLORS[mi % len(MEMBRANE_COLORS)]
        mem = membranes[mi]

        # Draw membrane boundary (dashed-style via thicker rect)
        draw.rectangle(
            [0, mem["yStart"], w - 1, mem["yEnd"]],
            outline=color, width=2,
        )
        draw.text((4, mem["yStart"] + 2), f"Membrane {mi+1}", fill=color)

        # Draw bounding box for each component
        for c in mem_comps:
            draw.rectangle(
                [c["xMin"], c["yMin"], c["xMax"], c["yMax"]],
                outline=color, width=1,
            )

        # Draw band row markers (horizontal lines at yCenter)
        for band in mem["bands"]:
            y = band["yCenter"]
            draw.line([(0, y), (w - 1, y)], fill=(255, 255, 0), width=1)

        # Draw lane x-position markers (vertical lines)
        for lx in mem["laneXPositions"]:
            draw.line(
                [(lx, mem["yStart"]), (lx, mem["yEnd"])],
                fill=(0, 255, 255), width=1,
            )

    vis_path = f"{output_dir}/gelgenie_visualization.png"
    vis.save(vis_path)

    result = {
        "imageWidth": w,
        "imageHeight": h,
        "inverted": bool(needs_inversion),
        "mask_path": mask_path,
        "visualization_path": vis_path,
        "membranes": membranes,
    }

    # Write the standard run_metadata.json handoff file the React side reads.
    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, "run_metadata.json"), "w") as f:
        json.dump(result, f)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: analyze.py <image_path> <output_dir>", file=sys.stderr)
        sys.exit(1)
    run(sys.argv[1], sys.argv[2])
    print(os.path.join(sys.argv[2], "run_metadata.json"))
