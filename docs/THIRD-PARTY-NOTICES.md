# Third-party notices (UI assets)

This file lists the assets bundled into the renderer that are not part of the project's own code. Runtime and
build-time npm packages are covered by their own `LICENSE` files in `node_modules` and by the lock file; this list
exists so the licence terms of the fonts and icons that ship inside the installer are in one visible place.

Everything below is bundled locally at build time. The app makes no network request for fonts or icons, and the
content security policy keeps `font-src 'self'` and `img-src 'self' data:` (`tests/security/no-net-imports.test.ts`
checks the built renderer for remote font, stylesheet and icon URLs).

| Asset | Package (exact version) | Licence | Use |
|---|---|---|---|
| Inter (variable, wght axis, woff2) | `@fontsource-variable/inter` 5.3.0 | SIL Open Font License 1.1 (font), MIT (package) | Interface typeface. Only the subsets the text needs are fetched, from the app's own files, through `unicode-range`. |
| Tabler Icons | `@tabler/icons-react` 3.50.0 | MIT | Interface icons. Single icon modules are imported from `components/ui/icons.ts`, so only the icons in use reach the bundle. |

## Inter

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter). Licensed under the SIL Open Font License,
Version 1.1, available at https://openfontlicense.org. The font files are redistributed unmodified through the
Fontsource package; the licence text is in `node_modules/@fontsource-variable/inter/LICENSE`.

## Tabler Icons

Copyright (c) 2020-2024 Pawel Kuna. Licensed under the MIT licence; the licence text is in
`node_modules/@tabler/icons-react/LICENSE`.

## Rule for new assets

Only permissive licences (MIT, BSD, Apache-2.0, ISC, OFL-1.1 for fonts). Pin the exact version, bundle the files, never
link a CDN, and add a row here in the same change.
