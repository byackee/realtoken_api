const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');
const { CronJob } = require('./models/CronJob');

// Créer l'application Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration du moteur de template EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(require('./middleware/ejsLayout'));

// Routes
const cronRoutes = require('./routes/cronRoutes');
app.use('/', cronRoutes);

// Route pour les erreurs 404
app.use((req, res) => {
  res.status(404).render('error', { error: 'Page non trouvée' });
});

// Garantir un certain délai avant de démarrer les tâches
// pour s'assurer que la base de données est prête
const STARTUP_DELAY = process.env.STARTUP_DELAY || 5000; // délai en ms

// Fonction pour démarrer les tâches cron actives
async function startCronJobs() {
  try {
    console.log(`⏳ Attente de ${STARTUP_DELAY/1000} secondes avant de démarrer les tâches cron...`);
    
    // Attendre que la base de données soit complètement initialisée
    setTimeout(async () => {
      console.log('🚀 Démarrage des tâches cron actives...');
      try {
        // Créer une tâche par défaut si aucune tâche n'existe
        await CronJob.createDefaultTaskIfNeeded();
        
        // Récupérer toutes les tâches pour mettre à jour leurs informations
        await CronJob.getAllJobs();
        
        // Démarrer toutes les tâches actives
        const startedCount = await CronJob.startAllActiveJobs();
        console.log(`✅ ${startedCount || 0} tâches actives démarrées avec succès`);
        
        // Mise à jour forcée des prochaines exécutions pour toutes les tâches
        console.log('🔄 Mise à jour des prochaines exécutions...');
        await CronJob.getAllJobs();
        
        console.log('✅ Processus de démarrage des tâches terminé');
        
        // Configurer une mise à jour périodique des prochaines exécutions
        setInterval(async () => {
          try {
            await CronJob.getAllJobs();
          } catch (error) {
            console.error('❌ Erreur lors de la mise à jour périodique des prochaines exécutions:', error);
          }
        }, 15000); // Mettre à jour toutes les 15 secondes
        
      } catch (error) {
        console.error('❌ Erreur lors du démarrage des tâches cron:', error);
      }
    }, STARTUP_DELAY);
  } catch (error) {
    console.error('❌ Erreur critique lors du démarrage des tâches:', error);
  }
}

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur de gestion des tâches cron démarré sur le port ${PORT}`);
  
  // Démarrer toutes les tâches actives avec un délai
  startCronJobs();
}); 