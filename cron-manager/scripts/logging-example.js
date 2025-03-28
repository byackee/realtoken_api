// Exemple d'utilisation de winston pour la journalisation avancée
const winston = require('winston');
const path = require('path');

// Configuration du logger Winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'logging-example' },
  transports: [
    // Écrire tous les logs au niveau 'info' et au-dessus dans le fichier combined.log
    new winston.transports.File({ 
      filename: path.join('/app/logs', 'winston-example-combined.log') 
    }),
    // Écrire tous les logs d'erreur dans le fichier error.log
    new winston.transports.File({ 
      filename: path.join('/app/logs', 'winston-example-error.log'), 
      level: 'error' 
    }),
    // Afficher les logs dans la console
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Fonction qui simule diverses opérations pour générer des logs
async function runOperations() {
  logger.info('🚀 Démarrage des opérations de test pour Winston');
  
  // Simuler différents niveaux de logs
  logger.debug('Ceci est un message de débogage');
  logger.info('Ceci est un message d\'information');
  logger.warn('Ceci est un avertissement');
  
  // Simuler une opération réussie
  logger.info('Tentative de connexion à la base de données');
  await new Promise(resolve => setTimeout(resolve, 500));
  logger.info('Connexion à la base de données réussie', { 
    dbName: 'example-db', 
    connectionTime: '500ms' 
  });
  
  // Simuler une opération avec des métriques
  logger.info('Traitement des données en cours');
  const startTime = Date.now();
  await new Promise(resolve => setTimeout(resolve, 1200));
  const duration = Date.now() - startTime;
  logger.info('Traitement des données terminé', { 
    duration: `${duration}ms`,
    recordsProcessed: 1000,
    successRate: '99.5%'
  });
  
  // Simuler une erreur
  try {
    logger.info('Tentative d\'opération risquée');
    throw new Error('Une erreur simulée s\'est produite');
  } catch (error) {
    logger.error('Erreur lors de l\'opération', { 
      error: error.message,
      stack: error.stack,
      context: {
        operation: 'riskyOperation',
        parameters: { id: 123, force: true }
      }
    });
  }
  
  // Logs finaux
  logger.info('👋 Toutes les opérations sont terminées');
}

// Exécuter le script
(async () => {
  console.log('Démarrage du script de démonstration Winston');
  await runOperations();
  console.log('Script terminé');
  
  // Bonne pratique : s'assurer que tous les logs sont écrits avant de quitter
  setTimeout(() => {
    process.exit(0);
  }, 1000);
})(); 