# Screenshots

Drop your screenshots of this shop here. They are listed in `report.json` in file-name order.

- Naming: `NN-short-title.png` — two-digit position, then a short kebab-case title,
  e.g. `01-home.png`, `02-product-crate-deposit.png`, `03-checkout-delivery-slots.png`.
  `.png`, `.jpg`, `.jpeg` and `.webp` are accepted.
- Captions (optional): one line per file in `captions.md`:

  ```
  01-home.png: Home page with the active promotions
  02-product-crate-deposit.png: Deposit shown separately from the crate price
  ```

Re-run `./oneshotshop evaluate <branch> --steps report` after adding screenshots.
