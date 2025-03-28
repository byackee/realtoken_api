const { CronJob } = require('../models/CronJob');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const os = require('os');

// Chemin de base des scripts (répertoire "scripts" dans le conteneur)
const SCRIPTS_BASE_PATH = process.env.SCRIPTS_PATH || '/app/scripts';
const LOGS_DIR = process.env.LOGS_DIR || '/app/logs';

// Controller pour la gestion des tâches cron
const cronController = {
  
  // Page d'accueil avec liste des tâches
  index: async (req, res) => {
    try {
      const jobs = await CronJob.getAllJobs();
      res.render('index', { jobs });
    } catch (error) {
      console.error('Erreur lors de la récupération des tâches:', error);
      res.status(500).render('error', { error: 'Erreur lors de la récupération des tâches' });
    }
  },
  
  // Formulaire pour créer une nouvelle tâche
  createForm: async (req, res) => {
    try {
      // Récupérer la liste des scripts disponibles dans le répertoire des scripts
      const scripts = await getAvailableScripts();
      res.render('create', { scripts });
    } catch (error) {
      console.error('Erreur lors de la récupération des scripts:', error);
      res.status(500).render('error', { error: 'Erreur lors de la récupération des scripts disponibles' });
    }
  },
  
  // Traitement de la création d'une tâche
  create: async (req, res) => {
    try {
      const { name, script_path, cron_expression, description } = req.body;
      
      // Validation de base
      if (!name || !script_path || !cron_expression) {
        return res.status(400).render('error', { 
          error: 'Les champs nom, chemin du script et expression cron sont obligatoires' 
        });
      }
      
      const job = await CronJob.createJob(name, script_path, cron_expression, description);
      res.redirect('/');
    } catch (error) {
      console.error('Erreur lors de la création de la tâche:', error);
      res.status(500).render('error', { error: 'Erreur lors de la création de la tâche' });
    }
  },
  
  // Formulaire pour modifier une tâche existante
  editForm: async (req, res) => {
    try {
      const { id } = req.params;
      const job = await CronJob.getJobById(id);
      
      if (!job) {
        return res.status(404).render('error', { error: 'Tâche non trouvée' });
      }
      
      // Récupérer la liste des scripts disponibles
      const scripts = await getAvailableScripts();
      
      res.render('edit', { job, scripts });
    } catch (error) {
      console.error(`Erreur lors de la récupération de la tâche ${req.params.id}:`, error);
      res.status(500).render('error', { error: 'Erreur lors de la récupération de la tâche' });
    }
  },
  
  // Traitement de la modification d'une tâche
  update: async (req, res) => {
    try {
      const { id } = req.params;
      const { name, script_path, cron_expression, description } = req.body;
      
      // Validation de base
      if (!name || !script_path || !cron_expression) {
        return res.status(400).render('error', { 
          error: 'Les champs nom, chemin du script et expression cron sont obligatoires' 
        });
      }
      
      const job = await CronJob.updateJob(id, name, script_path, cron_expression, description);
      
      res.redirect('/');
    } catch (error) {
      console.error(`Erreur lors de la mise à jour de la tâche ${req.params.id}:`, error);
      res.status(500).render('error', { error: 'Erreur lors de la mise à jour de la tâche' });
    }
  },
  
  // Supprimer une tâche
  delete: async (req, res) => {
    try {
      const { id } = req.params;
      await CronJob.deleteJob(id);
      
      res.redirect('/');
    } catch (error) {
      console.error(`Erreur lors de la suppression de la tâche ${req.params.id}:`, error);
      res.status(500).render('error', { error: 'Erreur lors de la suppression de la tâche' });
    }
  },
  
  // Démarrer une tâche
  start: async (req, res) => {
    try {
      const { id } = req.params;
      await CronJob.startJob(id);
      
      res.redirect('/');
    } catch (error) {
      console.error(`Erreur lors du démarrage de la tâche ${req.params.id}:`, error);
      res.status(500).render('error', { error: 'Erreur lors du démarrage de la tâche' });
    }
  },
  
  // Arrêter une tâche
  stop: async (req, res) => {
    try {
      const { id } = req.params;
      await CronJob.stopJob(id);
      
      res.redirect('/');
    } catch (error) {
      console.error(`Erreur lors de l'arrêt de la tâche ${req.params.id}:`, error);
      res.status(500).render('error', { error: 'Erreur lors de l\'arrêt de la tâche' });
    }
  },
  
  // Exécuter une tâche immédiatement
  run: async (req, res) => {
    try {
      const { id } = req.params;
      await CronJob.runJobNow(id);
      
      res.redirect('/');
    } catch (error) {
      console.error(`Erreur lors de l'exécution immédiate de la tâche ${req.params.id}:`, error);
      res.status(500).render('error', { error: 'Erreur lors de l\'exécution immédiate de la tâche' });
    }
  },
  
  // Afficher les logs d'une tâche
  viewLogs: async (req, res) => {
    try {
      const { id } = req.params;
      const job = await CronJob.getJobById(id);
      
      if (!job) {
        return res.status(404).render('error', { error: 'Tâche non trouvée' });
      }
      
      // Créer le répertoire des logs s'il n'existe pas
      if (!fs.existsSync(LOGS_DIR)){
        fs.mkdirSync(LOGS_DIR, { recursive: true });
      }
      
      const scriptName = path.basename(job.script_path);
      const logFilePath = path.join(LOGS_DIR, `${scriptName}.log`);
      
      let logs = "Aucun log disponible pour ce script.";
      
      // Récupérer les logs s'ils existent
      if (fs.existsSync(logFilePath)) {
        // Lire les 500 dernières lignes du fichier de log (limité pour éviter de surcharger la page)
        const logContent = await new Promise((resolve, reject) => {
          exec(`tail -n 500 ${logFilePath}`, (error, stdout, stderr) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(stdout);
          });
        });
        
        logs = logContent || "Fichier de log vide.";
      }
      
      res.render('logs', { job, logs });
    } catch (error) {
      console.error(`Erreur lors de la récupération des logs de la tâche ${req.params.id}:`, error);
      res.status(500).render('error', { error: 'Erreur lors de la récupération des logs' });
    }
  },
  
  // API pour récupérer toutes les tâches (format JSON)
  apiGetAllJobs: async (req, res) => {
    try {
      const jobs = await CronJob.getAllJobs();
      res.json(jobs);
    } catch (error) {
      console.error('Erreur lors de la récupération des tâches (API):', error);
      res.status(500).json({ error: 'Erreur lors de la récupération des tâches' });
    }
  },
  
  // API pour récupérer une tâche par son ID (format JSON)
  apiGetJobById: async (req, res) => {
    try {
      const { id } = req.params;
      const job = await CronJob.getJobById(id);
      
      if (!job) {
        return res.status(404).json({ error: 'Tâche non trouvée' });
      }
      
      res.json(job);
    } catch (error) {
      console.error(`Erreur lors de la récupération de la tâche ${req.params.id} (API):`, error);
      res.status(500).json({ error: 'Erreur lors de la récupération de la tâche' });
    }
  }
};

// Fonction pour récupérer la liste des scripts disponibles
async function getAvailableScripts() {
  return new Promise((resolve, reject) => {
    // Vérifier si le répertoire existe
    if (!fs.existsSync(SCRIPTS_BASE_PATH)) {
      // Créer le répertoire s'il n'existe pas
      try {
        fs.mkdirSync(SCRIPTS_BASE_PATH, { recursive: true });
        resolve([]);
        return;
      } catch (err) {
        reject(new Error(`Impossible de créer le répertoire des scripts: ${err.message}`));
        return;
      }
    }
    
    fs.readdir(SCRIPTS_BASE_PATH, (err, files) => {
      if (err) {
        reject(err);
        return;
      }
      
      // Filtrer uniquement les fichiers .js
      const scripts = files
        .filter(file => file.endsWith('.js'))
        .map(file => ({
          name: file,
          path: path.join(SCRIPTS_BASE_PATH, file)
        }));
      
      resolve(scripts);
    });
  });
}

module.exports = cronController; 