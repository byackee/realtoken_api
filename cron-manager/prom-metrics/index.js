const client = require('prom-client');

// Créer un registre pour les métriques
const Registry = client.Registry;
const register = new Registry();

// Ajouter les métriques par défaut (CPU, mémoire, etc.)
client.collectDefaultMetrics({ register });

// Métriques personnalisées
// Compteur pour le nombre total de tâches
const cronJobsTotal = new client.Gauge({
  name: 'cron_jobs_total',
  help: 'Nombre total de tâches cron configurées',
  labelNames: ['status'],
  registers: [register]
});

// Compteur pour le nombre d'exécutions des tâches
const cronJobExecutions = new client.Counter({
  name: 'cron_job_executions_total',
  help: 'Nombre total d\'exécutions des tâches cron',
  labelNames: ['job_id', 'job_name', 'status'],
  registers: [register]
});

// Temps d'exécution des tâches
const cronJobExecutionDuration = new client.Histogram({
  name: 'cron_job_execution_duration_seconds',
  help: 'Durée d\'exécution des tâches cron en secondes',
  labelNames: ['job_id', 'job_name'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600], // buckets in seconds
  registers: [register]
});

// Jauge pour la prochaine exécution prévue (en secondes à partir de maintenant)
const cronJobNextExecution = new client.Gauge({
  name: 'cron_job_next_execution_seconds',
  help: 'Temps restant en secondes avant la prochaine exécution',
  labelNames: ['job_id', 'job_name'],
  registers: [register]
});

// Jauge pour le statut actuel de chaque tâche (1 = running, 0 = stopped)
const cronJobStatus = new client.Gauge({
  name: 'cron_job_status',
  help: 'Statut actuel de la tâche cron (1 = running, 0 = stopped)',
  labelNames: ['job_id', 'job_name'],
  registers: [register]
});

// Fonction pour mettre à jour les métriques du nombre de tâches
function updateJobsCountMetrics(jobs) {
  // Réinitialiser les compteurs
  cronJobsTotal.reset();
  
  // Compter les tâches par statut
  const statusCount = jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});
  
  // Mettre à jour les métriques
  Object.entries(statusCount).forEach(([status, count]) => {
    cronJobsTotal.labels(status).set(count);
  });
}

// Fonction pour mettre à jour les métriques de statut et prochaine exécution
function updateJobStatusMetrics(jobs) {
  const now = Date.now();
  
  jobs.forEach(job => {
    // Mettre à jour le statut (1 = running, 0 = stopped)
    cronJobStatus.labels(job.id, job.name).set(job.status === 'running' ? 1 : 0);
    
    // Calculer et mettre à jour le temps restant avant la prochaine exécution
    if (job.next_run && job.status === 'running') {
      const nextRunTime = new Date(job.next_run).getTime();
      const secondsUntilNextRun = Math.max(0, (nextRunTime - now) / 1000);
      cronJobNextExecution.labels(job.id, job.name).set(secondsUntilNextRun);
    } else {
      // Si pas de prochaine exécution ou tâche arrêtée, mettre à 0 ou une valeur négative
      cronJobNextExecution.labels(job.id, job.name).set(-1);
    }
  });
}

// Fonction pour enregistrer l'exécution d'une tâche
function recordJobExecution(jobId, jobName, status) {
  cronJobExecutions.labels(jobId, jobName, status).inc();
}

// Fonction pour mesurer la durée d'exécution d'une tâche
function measureJobExecutionTime(jobId, jobName, callback) {
  const end = cronJobExecutionDuration.labels(jobId, jobName).startTimer();
  return (...args) => {
    end();
    callback(...args);
  };
}

module.exports = {
  register,
  updateJobsCountMetrics,
  updateJobStatusMetrics,
  recordJobExecution,
  measureJobExecutionTime
}; 