var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/demo', function(req, res, next) {
  res.redirect('/booking?doctor_id=17')
});

module.exports = router;
