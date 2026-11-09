# Define-XML stylesheets

Put the CDISC stylesheets here before `npm run build`:

- `define2-1-0.xsl` (Define-XML 2.1)
- `define2-0-0.xsl` (Define-XML 2.0)

They come with the Define-XML packages on cdisc.org and are not committed to this repository; check CDISC's terms before you commit or redistribute them.

When a file is present, the build inlines it, and the submission ZIP archives it next to `define.xml`, which then starts with `<?xml-stylesheet type="text/xsl" href="define2-1-0.xsl"?>`. When it is absent, `define.xml` has no stylesheet instruction and the ZIP has no `.xsl`.
