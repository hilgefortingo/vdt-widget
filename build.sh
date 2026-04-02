#!/bin/bash
# Build the VDT widget by concatenating parser + main into a single deployable file
echo "Building VDT widget..."
cat data-binding-parser.js > dist/main.js
echo "" >> dist/main.js
cat main.js >> dist/main.js
echo "Built dist/main.js"

# Copy other files
cp widget.json dist/widget.json
cp styling.js dist/styling.js
echo "Build complete. Files in dist/"
