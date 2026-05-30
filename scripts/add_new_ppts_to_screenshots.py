#!/usr/bin/env python3
"""Add newly supplied PPT/PPTX files to a Gemini PPT screenshot set.

The script appends new deckNN folders under gemini_ppt_screenshots_full,
converts PPT/PPTX -> PDF with LibreOffice, rasterizes PDF -> PNG with Poppler,
and appends entries to manifest.json. It intentionally does not edit
gemini_progress.json.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Append new PPT/PPTX decks to gemini_ppt_screenshots_full."
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path.cwd(),
        help="Course workspace containing PPT/PPTX files. Defaults to cwd.",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Screenshot root. Defaults to <workspace>/gemini_ppt_screenshots_full.",
    )
    parser.add_argument(
        "--ppt",
        action="append",
        type=Path,
        default=[],
        help="PPT/PPTX file to append. Repeat for multiple files. If omitted, auto-detect files newer than the existing screenshot set.",
    )
    parser.add_argument(
        "--scale-to-x",
        type=int,
        default=1800,
        help="PNG width for pdftoppm. Existing Java screenshots use 1800.",
    )
    parser.add_argument(
        "--soffice",
        type=Path,
        default=None,
        help="Path to soffice.exe. Defaults to PATH or common Windows install paths.",
    )
    parser.add_argument(
        "--pdftoppm",
        type=Path,
        default=None,
        help="Path to pdftoppm/pdftoppm.exe. Defaults to PATH or common Windows Poppler install paths.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the planned additions without converting or writing files.",
    )
    parser.add_argument(
        "--allow-duplicate-source",
        action="store_true",
        help="Allow a PPT/PPTX whose file name is already present in manifest.json.",
    )
    return parser.parse_args()


def resolve_tool(explicit: Path | None, names: list[str], common: list[Path]) -> Path:
    if explicit:
        path = explicit.expanduser().resolve()
        if path.exists():
            return path
        raise SystemExit(f"Tool not found: {path}")

    for name in names:
        found = shutil.which(name)
        if found:
            return Path(found)

    for path in common:
        if path.exists():
            return path

    raise SystemExit(
        "Missing required tool. Install it, add it to PATH, or pass the tool path explicitly."
    )


def load_manifest(path: Path) -> list[dict]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8-sig")
    data = json.loads(text)
    if not isinstance(data, list):
        raise SystemExit(f"Expected manifest list at {path}")
    return data


def existing_deck_indexes(root: Path, manifest: list[dict]) -> set[int]:
    indexes = {
        int(item["deckIndex"])
        for item in manifest
        if isinstance(item, dict) and str(item.get("deckIndex", "")).isdigit()
    }
    if root.exists():
        for entry in root.iterdir():
            if entry.is_dir():
                match = re.match(r"deck(\d+)_", entry.name)
                if match:
                    indexes.add(int(match.group(1)))
    return indexes


def latest_existing_mtime(root: Path, manifest_path: Path) -> float:
    mtimes: list[float] = []
    if manifest_path.exists():
        mtimes.append(manifest_path.stat().st_mtime)
    if root.exists():
        for entry in root.iterdir():
            if entry.is_dir() and re.match(r"deck\d+_", entry.name):
                mtimes.append(entry.stat().st_mtime)
    return max(mtimes, default=0.0)


def sort_key_for_ppt(path: Path) -> tuple[int, str]:
    match = re.search(r"Lesson[_\s-]*(\d+)", path.stem, flags=re.IGNORECASE)
    lesson = int(match.group(1)) if match else 10_000
    return lesson, path.name.lower()


def auto_detect_ppts(workspace: Path, root: Path, manifest_path: Path) -> list[Path]:
    cutoff = latest_existing_mtime(root, manifest_path)
    candidates = [
        path
        for pattern in ("*.ppt", "*.pptx")
        for path in workspace.glob(pattern)
        if not path.name.startswith("~$") and path.stat().st_mtime > cutoff
    ]
    return sorted(candidates, key=sort_key_for_ppt)


def sanitize_stem(stem: str) -> str:
    safe = re.sub(r"[()\[\]{}]", "_", stem)
    safe = re.sub(r"[^\w\u4e00-\u9fff]+", "_", safe, flags=re.UNICODE)
    safe = re.sub(r"_+", "_", safe).strip("_")
    return safe or "PPT"


def run(command: list[str]) -> None:
    print("RUN", " ".join(command))
    completed = subprocess.run(command, check=False)
    if completed.returncode != 0:
        raise SystemExit(f"Command failed with exit code {completed.returncode}")


def convert_to_pdf(
    ppt: Path, pdf_dir: Path, profile_dir: Path, soffice: Path
) -> Path:
    pdf_dir.mkdir(parents=True, exist_ok=True)
    profile_dir.mkdir(parents=True, exist_ok=True)
    profile_uri = profile_dir.resolve().as_uri()
    run(
        [
            str(soffice),
            f"-env:UserInstallation={profile_uri}",
            "--headless",
            "--nologo",
            "--nofirststartwizard",
            "--convert-to",
            "pdf",
            "--outdir",
            str(pdf_dir),
            str(ppt),
        ]
    )
    pdf_path = pdf_dir / f"{ppt.stem}.pdf"
    if not pdf_path.exists():
        raise SystemExit(f"Converted PDF was not created: {pdf_path}")
    return pdf_path


def rasterize_pdf(
    pdf_path: Path,
    out_dir: Path,
    deck_prefix: str,
    pdftoppm: Path,
    scale_to_x: int,
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    existing_pngs = list(out_dir.glob("*.png"))
    if existing_pngs:
        raise SystemExit(f"Refusing to write into non-empty deck folder: {out_dir}")

    tmp_prefix = out_dir / "tmp_slide"
    run(
        [
            str(pdftoppm),
            "-png",
            "-scale-to-x",
            str(scale_to_x),
            "-scale-to-y",
            "-1",
            str(pdf_path),
            str(tmp_prefix),
        ]
    )

    tmp_files = sorted(
        out_dir.glob("tmp_slide-*.png"),
        key=lambda p: int(re.search(r"-(\d+)\.png$", p.name).group(1)),
    )
    if not tmp_files:
        raise SystemExit(f"No PNGs were produced for {pdf_path}")

    slide_paths: list[Path] = []
    for index, tmp in enumerate(tmp_files, start=1):
        target = out_dir / f"{deck_prefix}_slide{index:03d}.png"
        tmp.replace(target)
        slide_paths.append(target)
    return slide_paths


def append_manifest(
    manifest_path: Path,
    manifest: list[dict],
    deck_index: int,
    source_name: str,
    slide_paths: list[Path],
) -> None:
    if manifest_path.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = manifest_path.with_name(
            f"manifest.backup-before-add-ppts-{stamp}.json"
        )
        shutil.copy2(manifest_path, backup)
        print(f"BACKUP {backup}")

    next_order = max((int(item.get("order", 0)) for item in manifest), default=0) + 1
    total = len(slide_paths)
    for slide_num, slide_path in enumerate(slide_paths, start=1):
        manifest.append(
            {
                "order": next_order,
                "deckIndex": deck_index,
                "source": source_name,
                "slide": slide_num,
                "totalSlidesInDeck": total,
                "path": str(slide_path.resolve()),
                "bytes": slide_path.stat().st_size,
            }
        )
        next_order += 1

    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> int:
    args = parse_args()
    workspace = args.workspace.expanduser().resolve()
    root = (
        args.root.expanduser().resolve()
        if args.root
        else workspace / "gemini_ppt_screenshots_full"
    )
    manifest_path = root / "manifest.json"
    pdf_dir = root / "_pdf"

    manifest = load_manifest(manifest_path)
    ppts = [path.expanduser().resolve() for path in args.ppt]
    if not ppts:
        ppts = auto_detect_ppts(workspace, root, manifest_path)

    if not ppts:
        print("No new PPT/PPTX files detected. Pass --ppt explicitly if needed.")
        return 0

    for ppt in ppts:
        if not ppt.exists() or ppt.suffix.lower() not in {".ppt", ".pptx"}:
            raise SystemExit(f"Invalid PPT/PPTX path: {ppt}")

    if not args.allow_duplicate_source:
        existing_sources = {
            str(item.get("source", ""))
            for item in manifest
            if isinstance(item, dict)
        }
        duplicates = [ppt.name for ppt in ppts if ppt.name in existing_sources]
        if duplicates:
            names = ", ".join(duplicates)
            raise SystemExit(
                f"These PPT/PPTX file names already exist in manifest.json: {names}. "
                "Use --allow-duplicate-source only if the duplicate is intentional."
            )

    indexes = existing_deck_indexes(root, manifest)
    next_index = max(indexes, default=0) + 1
    plan = []
    for offset, ppt in enumerate(ppts):
        deck_index = next_index + offset
        deck_prefix = f"deck{deck_index:02d}"
        folder = root / f"{deck_prefix}_{sanitize_stem(ppt.stem)}"
        plan.append((deck_index, deck_prefix, ppt, folder))

    print("PLAN")
    for deck_index, _deck_prefix, ppt, folder in plan:
        print(f"  deck{deck_index:02d}: {ppt.name} -> {folder}")

    if args.dry_run:
        return 0

    soffice = resolve_tool(
        args.soffice,
        ["soffice", "soffice.exe", "libreoffice"],
        [
            Path(r"C:\Program Files\LibreOffice\program\soffice.exe"),
            Path(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
        ],
    )
    pdftoppm = resolve_tool(
        args.pdftoppm,
        ["pdftoppm", "pdftoppm.exe"],
        [
            Path(r"C:\Program Files\poppler\Library\bin\pdftoppm.exe"),
            Path(r"C:\poppler\Library\bin\pdftoppm.exe"),
        ],
    )

    root.mkdir(parents=True, exist_ok=True)
    for deck_index, deck_prefix, ppt, folder in plan:
        profile = root / f"_lo_profile_{deck_index:02d}"
        pdf_path = convert_to_pdf(ppt, pdf_dir, profile, soffice)
        slides = rasterize_pdf(
            pdf_path, folder, deck_prefix, pdftoppm, args.scale_to_x
        )
        append_manifest(manifest_path, manifest, deck_index, ppt.name, slides)
        print(f"DONE {folder.name} slides={len(slides)}")

    print("gemini_progress.json was not modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
