#!/bin/bash
# Build the VDT widget by concatenating parser + main into a single deployable file
echo "Building VDT widget..."
cat data-binding-parser.js > dist/main.js
echo "" >> dist/main.js
cat main.js >> dist/main.js
cp widget.json dist/widget.json
cp styling.js dist/styling.js
echo "Built dist/"

# Also build to vdt/ (GitHub Pages serving path)
cp dist/main.js vdt/main.js
cp styling.js vdt/styling.js
echo "Built vdt/"
echo "Build complete."
