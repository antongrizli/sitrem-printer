/** Sizes exposed by the installed 4BARCODE/Vretti 420B macOS driver. */
export const VRETTI_420B_STOCK_PRESETS = [
  { id: 'stock_70x25', name: 'Current stock — 70 × 25 mm', widthMm: 70, heightMm: 25, default: true },
  { id: 'inch_1_5x1', name: '1.5 × 1 in', widthMm: 38.1, heightMm: 25.4 },
  { id: 'inch_2x1', name: '2 × 1 in', widthMm: 50.8, heightMm: 25.4 },
  // The driver describes this stock in inches; dimensions are rounded to the
  // Connector contract's 0.1 mm precision.
  { id: 'inch_2_25x1_25', name: '2.25 × 1.25 in', widthMm: 57.2, heightMm: 31.8 },
  { id: 'inch_3x1', name: '3 × 1 in', widthMm: 76.2, heightMm: 25.4 },
  { id: 'inch_3x2', name: '3 × 2 in', widthMm: 76.2, heightMm: 50.8 },
  { id: 'mm_40x20', name: '40 × 20 mm', widthMm: 40, heightMm: 20 },
  { id: 'mm_50x30', name: '50 × 30 mm', widthMm: 50, heightMm: 30 },
  { id: 'mm_60x40', name: '60 × 40 mm', widthMm: 60, heightMm: 40 },
  { id: 'mm_100x100', name: '100 × 100 mm', widthMm: 100, heightMm: 100 },
  { id: 'mm_100x150', name: '100 × 150 mm', widthMm: 100, heightMm: 150 },
  { id: 'inch_2x4', name: '2 × 4 in', widthMm: 50.8, heightMm: 101.6 },
  { id: 'inch_4x4', name: '4 × 4 in', widthMm: 101.6, heightMm: 101.6 },
  { id: 'inch_4x6', name: '4 × 6 in', widthMm: 101.6, heightMm: 152.4 },
  { id: 'app_40x30', name: '40 × 30 mm (application preset)', widthMm: 40, heightMm: 30 },
  { id: 'app_50x25', name: '50 × 25 mm (application preset)', widthMm: 50, heightMm: 25 },
  { id: 'app_58x40', name: '58 × 40 mm (application preset)', widthMm: 58, heightMm: 40 },
  { id: 'app_70x50', name: '70 × 50 mm (application preset)', widthMm: 70, heightMm: 50 },
  { id: 'app_80x50', name: '80 × 50 mm (application preset)', widthMm: 80, heightMm: 50 },
  { id: 'app_100x50', name: '100 × 50 mm (application preset)', widthMm: 100, heightMm: 50 },
  { id: 'app_105x148', name: '105 × 148 mm (application preset)', widthMm: 105, heightMm: 148 },
] as const;
