/**
 * POST /api/pos/scan
 *
 * One scan in, one resolved line out. The till posts the digits its scanner
 * read and nothing else — no quantity, no amount. The server owns the
 * catalogue, the label format and the arithmetic, so a tampered or simply
 * stale client cannot bill a weight of its own choosing.
 *
 * This also replaces the till's previous client-side lookup, which matched the
 * scan against a product array fetched once when the screen mounted: a product
 * created minutes earlier was reported as "unknown barcode" until the page was
 * reloaded, and a scale label could never resolve at all.
 */
import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { resolveScan } from '../services/scan-resolver';

const router = Router();

router.post('/scan', requireRole('owner', 'manager', 'cashier', 'waiter'), (req: Request, res: Response) => {
  try {
    const code = String((req.body ?? {}).code ?? '').trim();
    if (!code) return res.status(400).json({ error: 'A barcode is required' });
    // A scanner emits digits; anything longer is a paste or a stray keystroke
    // sequence, and is refused before it reaches a LIKE-free indexed lookup.
    if (code.length > 64) return res.status(400).json({ error: 'Barcode too long' });

    const outcome = resolveScan(getDatabase(), code);

    // A rejected scan is a 200, not an error status: it is a normal till event
    // the cashier has to act on, and `reason` is what selects the message they
    // see. Reserving 4xx for malformed requests keeps the two apart.
    res.json(outcome);
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const posScanRoutes = router;
