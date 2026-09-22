// Copies public/users.json into public/users.js so a page opened straight from disk can sign
// customers in (browsers block fetching a JSON file from file://, but a <script> tag works).
//   npm run build:users      after editing public/users.json
//
// These are mock accounts for the demo only — plain-text passwords, shipped to the browser.
// Never do this with real credentials; a real app checks passwords only on the server, hashed.
const fs = require("fs");
const path = require("path");

const source = path.join(__dirname, "public", "users.json");
const target = path.join(__dirname, "public", "users.js");

const render = () =>
  "/* Generated from users.json by `npm run build:users`. Do not edit by hand.\n" +
  "   Mock accounts for this demo only — see the comment in build-users.js. */\n" +
  "window.TRACKBOT_USERS = " + JSON.stringify(JSON.parse(fs.readFileSync(source, "utf8")), null, 2) + ";\n";

if (require.main === module) {
  fs.writeFileSync(target, render());
  console.log("wrote public/users.js");
}
module.exports = { render };
