const express = require('express');
const router = express.Router();
const cronController = require('../controllers/cronController');

// Routes pour l'interface web
router.get('/', cronController.index);
router.get('/create', cronController.createForm);
router.post('/create', cronController.create);
router.get('/edit/:id', cronController.editForm);
router.post('/edit/:id', cronController.update);
router.get('/delete/:id', cronController.delete);
router.get('/start/:id', cronController.start);
router.get('/stop/:id', cronController.stop);
router.get('/run/:id', cronController.run);
router.get('/logs/:id', cronController.viewLogs);

// Routes pour l'API
router.get('/api/jobs', cronController.apiGetAllJobs);
router.get('/api/jobs/:id', cronController.apiGetJobById);

module.exports = router; 