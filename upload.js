const multer = require('multer');
const path = require('path');
const fs = require('fs');

function makeUploader(subdir) {
  const dest = path.join(__dirname, '..', 'uploads', subdir);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, dest),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = `${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`;
      cb(null, name);
    }
  });
  return multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });
}

module.exports = { makeUploader };
