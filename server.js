const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 4175);

app.use(express.static(__dirname, { index: "index.html" }));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`YT Player activo en http://localhost:${PORT}`);
});
