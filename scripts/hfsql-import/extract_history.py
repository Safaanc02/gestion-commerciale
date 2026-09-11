#!/usr/bin/env python3
"""
Export the shop's sales history from its WinDev till as CSV.

    python3 extract_history.py <dossier-export> <dossier-sortie>

An archive, not an import: these rows are kept for the record and never enter
the working database. The shop opens on a clean till, and a decoding mistake
here cannot skew a report or a day's takings.

Two files come out. `ventes.csv` is one row per sale — date, number, total.
`lignes-vendues.csv` is one row per item sold, which is where the interest is:
what moved, when, at what price, over two years.

Rows that cannot be true are set aside rather than dropped in silence: a free
slot whose first bytes happen to look like a date decodes into a sale of three
thousand bags at forty thousand dirhams each. 310 such lines out of 215,000
carried 252 of the 263 million the first pass totalled. They go to
`exclus.csv` so the judgement can be checked rather than trusted.

What is deliberately NOT exported: the field at offset 113 of a sale header.
It is money and it is consistently below the total, so it looks like a cost
basis — but the ratio ranges from 0.38 to 0.89 with a median of 0.65, where
the shop's own catalogue gives a median margin of 17%. It is something else,
and a money column with a confident wrong name in an archive is worse than a
missing one.
"""
import csv
import os
import re
import struct
import sys

ENCODING = 'cp1256'
DATE = re.compile(rb'^(20(?:1[5-9]|2[0-6]))([01][0-9])([0-3][0-9])$')

# Recovered by inspection and checked on load; see the counts this prints.
SALE = {'size': 301, 'date': 0, 'number': 127, 'total': 212, 'raw_total': 19}
LINE = {'size': 246, 'date': 0, 'price': 9, 'barcode': (96, 13),
        'name': (177, 38), 'sale_number': 147, 'quantity': 238}


def text(raw: bytes) -> str:
    decoded = raw.split(b'\x00')[0].decode(ENCODING, 'replace')
    return re.sub(r'\s+', ' ', decoded).strip()


def money(raw: bytes, off: int) -> float:
    """WinDev currency: a signed 64-bit integer scaled by a million."""
    return int.from_bytes(raw[off:off + 8], 'little', signed=True) / 1_000_000


def records(path: str, size: int):
    """
    Walk the fixed-length records, skipping anything without a real date.

    The file opens with a header and carries free slots throughout; a slot
    whose first eight bytes are not a date is one of those, not a sale.
    """
    raw = open(path, 'rb').read()
    first = re.search(rb'20(?:1[5-9]|2[0-6])[01][0-9][0-3][0-9]', raw)
    if not first:
        raise SystemExit(f'{path}: no dated record found — not the expected layout')
    base = first.start() % size
    total = (len(raw) - base) // size
    kept = 0
    for i in range(total):
        rec = raw[base + i * size: base + (i + 1) * size]
        match = DATE.match(rec[LINE['date']:LINE['date'] + 8])
        if not match:
            continue
        kept += 1
        yield f"{match.group(1).decode()}-{match.group(2).decode()}-{match.group(3).decode()}", rec
    print(f'  {os.path.basename(path)}: {kept:,} lues sur {total:,} emplacements')


# What a grocery can plausibly ring up. A slot that decodes beyond this is not
# a sale that happened; it is a slot that was never one.
MAX_SALE = 100_000.0
MAX_LINE = 100_000.0
MAX_QTY = 1_000.0


def export_sales(src: str, out: str, rejects: csv.writer) -> tuple:
    path = os.path.join(out, 'ventes.csv')
    kept = dropped = 0
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['date', 'numero', 'total'])
        for date, rec in records(os.path.join(src, 'Commande.FIC'), SALE['size']):
            total = money(rec, SALE['total'])
            number = int.from_bytes(rec[SALE['number']:SALE['number'] + 4], 'little')
            if not (0 <= total <= MAX_SALE):
                rejects.writerow(['vente', date, number, f'{total:.2f}', '', 'total hors plage'])
                dropped += 1
                continue
            w.writerow([date, number, f'{total:.2f}'])
            kept += 1
    return kept, dropped


def export_lines(src: str, out: str, rejects: csv.writer) -> tuple:
    path = os.path.join(out, 'lignes-vendues.csv')
    kept = dropped = 0
    b_off, b_len = LINE['barcode']
    n_off, n_len = LINE['name']
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['date', 'vente', 'code_barres', 'produit', 'quantite', 'prix_unitaire', 'total_ligne'])
        for date, rec in records(os.path.join(src, 'LigneCde.FIC'), LINE['size']):
            try:
                qty = struct.unpack('<d', rec[LINE['quantity']:LINE['quantity'] + 8])[0]
            except struct.error:
                continue
            # A weighed line carries a fraction; a nonsense quantity means the
            # slot was not what it looked like, and is dropped rather than
            # written as a sale of forty thousand tins.
            price = money(rec, LINE['price'])
            name = text(rec[n_off:n_off + n_len])
            line_total = qty * price
            plausible = (qty == qty and 0 < qty <= MAX_QTY
                         and 0 <= price <= MAX_LINE and line_total <= MAX_LINE)
            if not plausible:
                rejects.writerow(['ligne', date, '', f'{price:.2f}', f'{qty:.3f}', name[:40]])
                dropped += 1
                continue
            w.writerow([date,
                        int.from_bytes(rec[LINE['sale_number']:LINE['sale_number'] + 4], 'little'),
                        text(rec[b_off:b_off + b_len]), name,
                        f'{qty:.3f}', f'{price:.2f}', f'{line_total:.2f}'])
            kept += 1
    return kept, dropped


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__.strip())
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)

    with open(os.path.join(out, 'exclus.csv'), 'w', newline='', encoding='utf-8') as fh:
        rejects = csv.writer(fh)
        rejects.writerow(['type', 'date', 'numero', 'prix', 'quantite', 'motif'])
        sales, sales_out = export_sales(src, out, rejects)
        lines, lines_out = export_lines(src, out, rejects)

    print(f'\n{sales:,} ventes        -> {out}/ventes.csv        ({sales_out} écartées)')
    print(f'{lines:,} lignes vendues -> {out}/lignes-vendues.csv ({lines_out} écartées)')
    print(f'{sales_out + lines_out} lignes invraisemblables -> {out}/exclus.csv')


if __name__ == '__main__':
    main()
