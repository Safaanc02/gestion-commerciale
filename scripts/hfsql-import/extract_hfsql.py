#!/usr/bin/env python3
"""
Read a WinDev/HFSQL Classic database and get its contents out as CSV.

    python3 extract_hfsql.py <dossier-export> <dossier-sortie>

The shop's till is a WinDev application, not the HSQLDB system we first
expected, so `scripts/hsql-import/` does not apply to it. HFSQL Classic stores
one table per `.FIC` file: a header, then fixed-length records. Text is
Windows-1256, which is what carries the Arabic product names — decoding it as
Latin-1 turns every one of them into mojibake.

The record layouts below were recovered by inspection and each one is checked
on load, so a different HFSQL version fails loudly instead of writing plausible
nonsense. Nothing here writes to the source files.
"""
import csv
import os
import re
import struct
import sys

ENCODING = "cp1256"


def text(raw: bytes) -> str:
    """
    Decode a fixed-width HFSQL text field, trimmed at its first NUL.

    Whitespace is collapsed because 45 product names in the shop's own data
    carry runs of typed-in CRLFs ("KIT KAT NESTLE\r\n...\r\nكوكيز 300غ").
    Left alone they break the CSV into extra rows and would print as blank
    lines on a receipt.
    """
    decoded = raw.split(b"\x00")[0].decode(ENCODING, "replace")
    return re.sub(r"\s+", " ", decoded).strip()


def money(raw: bytes, off: int) -> float:
    """
    WinDev currency: a signed 64-bit integer scaled by a million.

    The scale was settled by checking that the values come out to exactly two
    decimals across the whole table rather than by assuming the usual four.
    """
    return int.from_bytes(raw[off:off + 8], "little", signed=True) / 1_000_000


def real(raw: bytes, off: int) -> float:
    return struct.unpack("<d", raw[off:off + 8])[0]


def read_families(path: str) -> dict:
    """
    Families are laid out on 77 bytes behind an eight-byte marker, but their
    records are not on a single grid — the file interleaves other structures —
    so they are read from the markers themselves rather than by striding.
    """
    raw = open(path, "rb").read()
    families = {}
    for match in re.finditer(rb"\xff{8}", raw):
        off = match.start()
        if off < 1700:
            continue  # still inside the header
        record = raw[off:off + 77]
        if len(record) < 77:
            continue
        fid = int.from_bytes(record[22:26], "little")
        name = text(record[26:])
        if 0 < fid < 100_000 and name:
            families.setdefault(fid, name)
    return families


# Offsets within a 434-byte product record. Anything not listed is either
# padding or a field the till fills but a grocery import has no use for.
PRODUCT = {
    "record_size": 434,
    "first_record": 2998,
    "barcode": (19, 13),
    "name": (136, 51),
    "cost": 187,
    "price_retail": 213,
    "price_2": 245,
    "price_3": 408,
    "stock": 223,
    "family": 231,
}


def read_products(path: str, families: dict) -> list:
    raw = open(path, "rb").read()
    if raw[:3] != b"PCS":
        raise SystemExit(f"{path}: not an HFSQL file (missing PCS signature)")

    size, first = PRODUCT["record_size"], PRODUCT["first_record"]
    count = (len(raw) - first) // size

    rows = []
    for i in range(count):
        r = raw[first + i * size: first + (i + 1) * size]
        off, width = PRODUCT["barcode"]
        barcode = text(r[off:off + width])
        off, width = PRODUCT["name"]
        name = text(r[off:off + width])
        if not barcode and not name:
            continue

        # The till carries three sale prices — retail, semi-wholesale and
        # wholesale — and fills them inconsistently. The first one actually set
        # is the shelf price.
        prices = [money(r, PRODUCT[k]) for k in ("price_retail", "price_2", "price_3")]
        price = next((p for p in prices if p > 0), 0.0)

        family_id = int.from_bytes(r[PRODUCT["family"]:PRODUCT["family"] + 4], "little")
        stock = real(r, PRODUCT["stock"])
        rows.append({
            "barcode": barcode,
            "name": name,
            "family_id": family_id,
            "family": families.get(family_id, ""),
            "cost": f"{money(r, PRODUCT['cost']):.2f}",
            "price": f"{price:.2f}",
            "price_retail": f"{prices[0]:.2f}",
            "price_2": f"{prices[1]:.2f}",
            "price_3": f"{prices[2]:.2f}",
            "stock": "" if stock != stock else f"{stock:.3f}",
        })
    return rows


def ean13_ok(code: str) -> bool:
    if not re.fullmatch(r"\d{13}", code):
        return False
    digits = [int(c) for c in code]
    check = (10 - sum(d * (3 if i % 2 else 1) for i, d in enumerate(digits[:12])) % 10) % 10
    return check == digits[12]


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__.strip())
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)

    families = read_families(os.path.join(src, "Famille.FIC"))
    products = read_products(os.path.join(src, "Produit.FIC"), families)

    with open(os.path.join(out, "familles.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "nom"])
        for fid, name in sorted(families.items()):
            w.writerow([fid, name])

    fields = ["barcode", "name", "family_id", "family", "cost", "price",
              "price_retail", "price_2", "price_3", "stock"]
    with open(os.path.join(out, "produits.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(products)

    arabic = sum(1 for p in products if any("؀" <= c <= "ۿ" for c in p["name"]))
    valid = sum(1 for p in products if ean13_ok(p["barcode"]))
    priced = sum(1 for p in products if float(p["price"]) > 0)
    negative = sum(1 for p in products if p["stock"] and float(p["stock"]) < 0)

    print(f"{len(families):>6} familles      -> {out}/familles.csv")
    print(f"{len(products):>6} produits      -> {out}/produits.csv")
    print(f"{valid:>6} codes-barres EAN-13 valides ({valid * 100 // max(len(products), 1)}%)")
    print(f"{priced:>6} avec un prix de vente")
    print(f"{arabic:>6} libellés contenant de l'arabe")
    print(f"{negative:>6} stocks négatifs")


if __name__ == "__main__":
    main()
