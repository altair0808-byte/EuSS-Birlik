const multer = require('multer');
const path = require('path');
const fs = require('fs');

// options: { maxSizeMB, fileFilter(req, file, cb) }
function makeUploader(subdir, options = {}) {
 const dest = path.join(__dirname, 'uploads', subdir);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, dest),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = `${Date.now()}_${Math.round(Math.random() * 1e6)}${ext}`;
      cb(null, name);
    }
  });
  const maxSizeMB = options.maxSizeMB || 25;
  return multer({
    storage,
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
    fileFilter: options.fileFilter
  });
}

module.exports = { makeUploader };
