// Copies public/orders.json into public/orders.js so a page opened straight from disk can use every
// order (browsers block fetching a JSON file from file://, but a <script> tag works).
//   npm run build:orders      after editing public/orders.json
const fs = require("fs");
const path = require("path");

const source = path.join(__dirname, "public", "orders.json");
const target = path.join(__dirname, "public", "orders.js");

const render = () =>
  "/* Generated from orders.json by `npm run build:orders`. Do not edit by hand. */\n" +
  "window.TRACKBOT_ORDERS = " + JSON.stringify(JSON.parse(fs.readFileSync(source, "utf8")), null, 2) + ";\n";

if (require.main === module) {
  fs.writeFileSync(target, render());
  console.log("wrote public/orders.js");
}
module.exports = { render };
