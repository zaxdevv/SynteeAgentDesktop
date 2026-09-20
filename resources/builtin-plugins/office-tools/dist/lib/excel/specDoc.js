// specDoc — полный справочник формата JSON-спеки excel_create.
// КОНТРАКТ: dist/lib/excel/spec.js обязан поддерживать всё описанное здесь.

function specDoc() {
  return `# excel_create spec reference

Workbook spec (argument "spec"):

{
  "sheets": [ sheet, ... ],              // REQUIRED, ≥ 1
  "definedNames": [ { "name": "TaxRate", "range": "Sheet1!$A$1" } ]   // optional named ranges
}

## Sheet

{
  "name": "Бюджет",                      // ≤ 31 chars, no []:*?/\\
  "columns": [ 20, { "width": 12 }, 8 ], // column widths (chars); number or { width }
  "rows": [ row, ... ],                  // REQUIRED
  "freeze": "A2",                        // freeze rows/cols above/left of ref
  "autoFilter": "A1:D10",                // autofilter range
  "merged": [ "A1:B1", "C3:C5" ],        // merged ranges
  "dataValidation": [
    { "range": "B2:B10", "type": "list"|"whole"|"decimal"|"date"|"textLength", "allowBlank": true,
      "operator": "between"|"notBetween"|"greaterThan"|..., "formulae": ['"Да,Нет"'] }
  ],
  "conditionalFormatting": [
    { "range": "C2:C10",
      "rules": [ rule, ... ] }
  ],
  // rule formats by type:
  //  cellIs:     { "type": "cellIs", "operator": "greaterThan"|"lessThan"|"equal"|"between"|..., "formulae": ["100"], "style": { "fill": "FFC7CE", "color": "9C0006" } }   // formulae REQUIRED
  //  expression: { "type": "expression", "formulae": ["A1>0"], "style": { … } }                                                                  // formulae REQUIRED
  //  top10:      { "type": "top10", "rank": 10, "percent": false, "bottom": false }
  //  colorScale: { "type": "colorScale", "cfvo": [{ "type": "min" }, { "type": "max" }], "colors": ["F8696B", "63BE7B"] }   // cfvo/colors optional (defaults min→max, red→green); cfvo types: min|max|num|percent|formula (with "value")
  //  dataBar:    { "type": "dataBar", "cfvo": [{ "type": "min" }, { "type": "max" }], "color": "638EC6" }
  //  iconSet:    { "type": "iconSet", "iconSet": "3TrafficLights"|"3Arrows"|"4RedToBlack"|"5Rating", "cfvo": [{ "type": "percent", "value": 0 }, …], "showValue": true }
  "protection": { "password": "secret", "selectLockedCells": true, "insertRows": false },  // optional; omit password → no password
  "rowHeights": { "1": 24, "3": 30 },    // optional: row number → height (points)
  "hiddenRows": [ 5, 6 ],                // optional: 1-based row numbers to hide
  "hiddenColumns": [ 2 ],                // optional: 1-based column numbers to hide
  "tabColor": "FF0000",                  // optional: sheet tab color (hex, no '#')
  "hidden": true | "veryHidden"          // optional: hide the sheet
}

## Row

[ cell, cell, ... ]                      // array of cells
{ "cells": [ cell, ... ], "height": 24, "style": { ...cell style } }   // styled row

## Cell

value                                    // shorthand: number | string | boolean | null
{ "value": 42,                           // value OR formula (not both)
  "formula": "=SUM(A1:A2)",              // Excel formula WITH leading =
  "numFmt": "#,##0.00" | "dd.mm.yyyy" | "0%" | "@",   // number format
  "style": {                             // optional cell style
    "font": { "name": "Calibri", "size": 11, "bold": true, "italic": true,
              "underline": true, "strike": true, "color": "FF0000" },
    "fill": "DEEBF7",                    // solid fill color (hex, no '#')
    "border": {                          // borders; each side optional
      "top"|"bottom"|"left"|"right": { "style": "thin"|"medium"|"thick"|"double"|"dashed"|"dotted"|"hair", "color": "000000" } },
    "alignment": { "horizontal": "left"|"center"|"right", "vertical": "top"|"middle"|"bottom",
                   "wrapText": true, "shrinkToFit": true, "textRotation": 90 }
  },
  "hyperlink": "https://…"               // cell becomes a link (value = text)
  "comment": { "text": "note", "author": "AI" }   // optional cell comment/note
}

## Colors
Hex without '#': "FF0000", "DEEBF7".

## Stats returned by excel_create
{ sheets, rows, cells, formulas, merged } and preview: { name, rows (first 10 rows of first sheet), totalRows, totalCols }.`
}

module.exports = { specDoc }
