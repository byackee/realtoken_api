const { Client } = require('pg');
const cron = require('node-cron');
const parser = require('cron-parser');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration PostgreSQL pour stocker les tâches cron
const pgClient = new Client({
  host: process.env.DB_HOST || "postgres",
  user: process.env.DB_USER || "nocodb",
  password: process.env.DB_PASSWORD || "nocodbpassword",
  database: process.env.DB_NAME || "nocodb",
  port: process.env.DB_PORT || 5432,
});

// Chemin pour les logs
const LOGS_DIR = process.env.LOGS_DIR || '/app/logs';

// Connexion à PostgreSQL
async function connectToDB() {
  try {
    await pgClient.connect();
    console.log("🟢 Connexion PostgreSQL réussie pour le gestionnaire de cron");
    await createCronJobTable();
  } catch (error) {
    console.error("❌ Erreur de connexion à PostgreSQL:", error);
  }
}

// Création de la table des tâches cron si elle n'existe pas
async function createCronJobTable() {
  try {
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        script_path VARCHAR(255) NOT NULL,
        cron_expression VARCHAR(100) NOT NULL,
        status VARCHAR(50) DEFAULT 'stopped',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_run TIMESTAMP,
        last_status VARCHAR(50),
        description TEXT,
        next_run TIMESTAMP
      )
    `);
    console.log("✅ Table cron_jobs vérifiée/créée");
    
    // Vérifier si la colonne next_run existe déjà
    try {
      await pgClient.query(`
        ALTER TABLE cron_jobs 
        ADD COLUMN IF NOT EXISTS next_run TIMESTAMP
      `);
    } catch (error) {
      console.error("Erreur lors de l'ajout de la colonne next_run:", error);
    }
  } catch (error) {
    console.error("❌ Erreur lors de la création de la table cron_jobs:", error);
  }
}

// Map pour stocker les tâches cron en cours d'exécution
const runningJobs = new Map();

// Fonction pour s'assurer que le répertoire des logs existe
function ensureLogDirExists() {
  if (!fs.existsSync(LOGS_DIR)) {
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      console.log(`✅ Répertoire des logs créé: ${LOGS_DIR}`);
    } catch (error) {
      console.error(`❌ Erreur lors de la création du répertoire des logs: ${error}`);
    }
  }
}

// Fonction pour logger dans un fichier
function logToFile(scriptPath, data) {
  ensureLogDirExists();
  
  const scriptName = path.basename(scriptPath);
  const logFilePath = path.join(LOGS_DIR, `${scriptName}.log`);
  
  // Date et heure formatées pour le log
  const timestamp = new Date().toISOString();
  
  // Préparer la ligne de log avec timestamp
  const logLine = `[${timestamp}] ${data}`;
  
  // Ajouter le log au fichier
  fs.appendFileSync(logFilePath, logLine + '\n');
}

// Fonction pour calculer la prochaine exécution d'une tâche cron
function getNextCronRunTime(cronExpression) {
  try {
    console.log(`Calcul de la prochaine exécution pour l'expression: ${cronExpression}`);
    
    if (!cronExpression) {
      console.error('Expression cron non définie');
      return null;
    }
    
    if (!cron.validate(cronExpression)) {
      console.error(`Expression cron invalide: ${cronExpression}`);
      return null;
    }
    
    try {
      // Utiliser cron-parser pour calculer la prochaine exécution
      const interval = parser.parseExpression(cronExpression);
      const nextRun = interval.next().toDate();
      console.log(`✅ Prochaine exécution calculée: ${nextRun.toISOString()}`);
      return nextRun;
    } catch (parserError) {
      console.error(`❌ Erreur lors du calcul avec cron-parser: ${parserError.message}`);
      
      // Méthode de secours avec node-cron
      try {
        const task = cron.schedule(cronExpression, () => {});
        const nextDate = task.nextDate();
        task.stop();
        
        const nextRun = nextDate.toDate();
        console.log(`⚠️ Calcul avec node-cron de secours: ${nextRun.toISOString()}`);
        return nextRun;
      } catch (cronError) {
        console.error(`❌ Erreur lors du calcul avec node-cron: ${cronError.message}`);
        
        // Dernier recours: ajouter 1 minute
        const now = new Date();
        const next = new Date(now.getTime() + 60000);
        console.log(`⚠️ Calcul de dernier recours (+1 minute): ${next.toISOString()}`);
        return next;
      }
    }
  } catch (error) {
    console.error(`❌ Erreur lors du calcul de la prochaine exécution: ${error.message}`);
    return null;
  }
}

// Classe de gestion des tâches cron
class CronJob {
  
  // Récupérer toutes les tâches
  static async getAllJobs() {
    try {
      console.log("🔍 Récupération de toutes les tâches");
      const result = await pgClient.query('SELECT * FROM cron_jobs ORDER BY created_at DESC');
      
      if (result.rowCount === 0) {
        console.log("ℹ️ Aucune tâche trouvée");
        return [];
      }
      
      console.log(`✅ ${result.rowCount} tâches récupérées`);
      
      // Liste des tâches à mettre à jour (pour éviter les mises à jour redondantes)
      const updateBatch = [];
      
      // Vérifier et corriger les tâches actives sans prochaine exécution définie
      for (const job of result.rows) {
        if (job.status === 'running') {
          const now = new Date();
          const nextRun = job.next_run ? new Date(job.next_run) : null;
          
          // Si pas de prochaine exécution ou déjà passée, recalculer
          if (!nextRun || nextRun < now) {
            const newNextRun = getNextCronRunTime(job.cron_expression);
            
            if (newNextRun) {
              updateBatch.push({
                id: job.id,
                next_run: newNextRun
              });
              
              // Mettre à jour pour l'affichage immédiat
              job.next_run = newNextRun;
            }
          }
        } else if (job.next_run !== null) {
          // Si la tâche est arrêtée mais a une prochaine exécution, la supprimer
          updateBatch.push({
            id: job.id,
            next_run: null
          });
          job.next_run = null;
        }
      }
      
      // Effectuer les mises à jour en lot si nécessaire
      if (updateBatch.length > 0) {
        console.log(`🔄 Mise à jour de ${updateBatch.length} prochaines exécutions...`);
        
        // Mise à jour groupée pour optimiser les performances
        const updates = updateBatch.map(async (update) => {
          try {
            if (update.next_run === null) {
              await pgClient.query(
                'UPDATE cron_jobs SET next_run = NULL WHERE id = $1',
                [update.id]
              );
              console.log(`✅ Prochaine exécution effacée pour la tâche ${update.id}`);
            } else {
              await pgClient.query(
                'UPDATE cron_jobs SET next_run = $1 WHERE id = $2',
                [update.next_run, update.id]
              );
              console.log(`✅ Prochaine exécution mise à jour pour la tâche ${update.id}: ${update.next_run.toISOString()}`);
            }
            return true;
          } catch (updateError) {
            console.error(`❌ Erreur lors de la mise à jour de la tâche ${update.id}:`, updateError);
            return false;
          }
        });
        
        const results = await Promise.all(updates);
        const successCount = results.filter(Boolean).length;
        console.log(`✅ ${successCount}/${updateBatch.length} tâches mises à jour avec succès`);
      }
      
      return result.rows;
    } catch (error) {
      console.error("❌ Erreur lors de la récupération des tâches:", error);
      throw error;
    }
  }
  
  // Récupérer une tâche par son ID
  static async getJobById(id) {
    try {
      const result = await pgClient.query('SELECT * FROM cron_jobs WHERE id = $1', [id]);
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const job = result.rows[0];
      
      // Calculer la prochaine exécution si la tâche est active
      if (job.status === 'running') {
        const now = new Date();
        const nextRun = job.next_run ? new Date(job.next_run) : null;
        
        if (!nextRun || nextRun < now) {
          const calculatedNextRun = getNextCronRunTime(job.cron_expression);
          job.next_run = calculatedNextRun;
          
          // Mettre à jour la base de données
          await pgClient.query(
            'UPDATE cron_jobs SET next_run = $1 WHERE id = $2',
            [calculatedNextRun, job.id]
          );
        }
      }
      
      return job;
    } catch (error) {
      console.error(`Erreur lors de la récupération de la tâche ${id}:`, error);
      throw error;
    }
  }
  
  // Créer une nouvelle tâche
  static async createJob(name, script_path, cron_expression, description = '') {
    try {
      const result = await pgClient.query(
        'INSERT INTO cron_jobs (name, script_path, cron_expression, description) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, script_path, cron_expression, description]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Erreur lors de la création de la tâche:", error);
      throw error;
    }
  }
  
  // Mettre à jour une tâche
  static async updateJob(id, name, script_path, cron_expression, description = '') {
    try {
      const result = await pgClient.query(
        'UPDATE cron_jobs SET name = $1, script_path = $2, cron_expression = $3, description = $4 WHERE id = $5 RETURNING *',
        [name, script_path, cron_expression, description, id]
      );
      
      // Si la tâche est en cours d'exécution, la redémarrer avec les nouveaux paramètres
      if (runningJobs.has(parseInt(id))) {
        await this.stopJob(id);
        await this.startJob(id);
      }
      
      return result.rows[0];
    } catch (error) {
      console.error(`Erreur lors de la mise à jour de la tâche ${id}:`, error);
      throw error;
    }
  }
  
  // Supprimer une tâche
  static async deleteJob(id) {
    try {
      // Arrêter la tâche si elle est en cours d'exécution
      if (runningJobs.has(parseInt(id))) {
        await this.stopJob(id);
      }
      
      const result = await pgClient.query('DELETE FROM cron_jobs WHERE id = $1 RETURNING *', [id]);
      return result.rows[0];
    } catch (error) {
      console.error(`Erreur lors de la suppression de la tâche ${id}:`, error);
      throw error;
    }
  }
  
  // Démarrer une tâche
  static async startJob(id) {
    try {
      const job = await this.getJobById(id);
      if (!job) {
        throw new Error(`Tâche ${id} non trouvée`);
      }
      
      if (runningJobs.has(parseInt(id))) {
        console.log(`La tâche ${id} est déjà en cours d'exécution`);
        
        // Mettre à jour la prochaine exécution si elle n'est pas définie
        if (!job.next_run) {
          const nextRun = getNextCronRunTime(job.cron_expression);
          if (nextRun) {
            await pgClient.query(
              'UPDATE cron_jobs SET next_run = $1 WHERE id = $2',
              [nextRun, id]
            );
            job.next_run = nextRun;
          }
        }
        
        return job;
      }
      
      if (!cron.validate(job.cron_expression)) {
        throw new Error(`Expression cron invalide: ${job.cron_expression}`);
      }
      
      const scriptPath = path.resolve(job.script_path);
      
      // Calculer la prochaine exécution
      const nextRun = getNextCronRunTime(job.cron_expression);
      if (!nextRun) {
        console.error(`Impossible de calculer la prochaine exécution pour la tâche ${id}`);
      } else {
        console.log(`Prochaine exécution pour la tâche ${id}: ${nextRun.toISOString()}`);
      }
      
      // Créer et démarrer la tâche cron
      const task = cron.schedule(job.cron_expression, async () => {
        console.log(`Exécution de la tâche ${job.name} (ID: ${job.id})`);
        logToFile(scriptPath, `========== DÉBUT DE L'EXÉCUTION DE LA TÂCHE: ${job.name} (ID: ${job.id}) ==========`);
        
        try {
          // Exécuter le script Node.js
          const childProcess = exec(`node ${scriptPath}`, (error, stdout, stderr) => {
            const now = new Date();
            let status = 'success';
            
            if (error) {
              console.error(`Erreur lors de l'exécution de la tâche ${job.id}:`, error);
              console.error(stderr);
              logToFile(scriptPath, `ERREUR: ${stderr}`);
              status = 'failed';
            } else {
              console.log(`Sortie de la tâche ${job.id}:`, stdout);
              logToFile(scriptPath, stdout);
            }
            
            // Ajouter une ligne de séparation
            logToFile(scriptPath, `========== FIN DE L'EXÉCUTION (STATUT: ${status}) ==========\n`);
            
            // Calculer la prochaine exécution
            const nextRun = getNextCronRunTime(job.cron_expression);
            
            // Mettre à jour la date de dernière exécution, le statut et la prochaine exécution
            pgClient.query(
              'UPDATE cron_jobs SET last_run = $1, last_status = $2, next_run = $3 WHERE id = $4',
              [now, status, nextRun, job.id]
            ).catch(err => {
              console.error(`Erreur lors de la mise à jour du statut de la tâche ${job.id}:`, err);
            });
          });
        } catch (execError) {
          console.error(`Erreur lors de l'exécution de la tâche ${job.id}:`, execError);
          logToFile(scriptPath, `ERREUR CRITIQUE: ${execError.message}`);
          logToFile(scriptPath, `========== FIN DE L'EXÉCUTION (STATUT: failed) ==========\n`);
          
          // Mettre à jour le statut en cas d'erreur
          const now = new Date();
          pgClient.query(
            'UPDATE cron_jobs SET last_run = $1, last_status = $2 WHERE id = $3',
            [now, 'failed', job.id]
          ).catch(err => {
            console.error(`Erreur lors de la mise à jour du statut de la tâche ${job.id}:`, err);
          });
        }
      });
      
      // Démarrer la tâche
      task.start();
      
      // Stocker la tâche dans la map des tâches en cours
      runningJobs.set(parseInt(id), task);
      
      // Mettre à jour le statut et la prochaine exécution dans la base de données
      let updateQuery, updateParams;
      
      if (nextRun) {
        updateQuery = 'UPDATE cron_jobs SET status = $1, next_run = $2 WHERE id = $3';
        updateParams = ['running', nextRun, id];
        console.log(`Mise à jour de la tâche ${id} avec prochaine exécution: ${nextRun.toISOString()}`);
      } else {
        updateQuery = 'UPDATE cron_jobs SET status = $1 WHERE id = $2';
        updateParams = ['running', id];
        console.log(`Mise à jour de la tâche ${id} sans prochaine exécution`);
      }
      
      await pgClient.query(updateQuery, updateParams);
      
      return { ...job, status: 'running', next_run: nextRun };
    } catch (error) {
      console.error(`Erreur lors du démarrage de la tâche ${id}:`, error);
      throw error;
    }
  }
  
  // Arrêter une tâche
  static async stopJob(id) {
    try {
      if (!runningJobs.has(parseInt(id))) {
        console.log(`La tâche ${id} n'est pas en cours d'exécution`);
        return await this.getJobById(id);
      }
      
      // Récupérer et arrêter la tâche
      const task = runningJobs.get(parseInt(id));
      task.stop();
      
      // Supprimer la tâche de la map
      runningJobs.delete(parseInt(id));
      
      // Mettre à jour le statut et supprimer la prochaine exécution dans la base de données
      await pgClient.query(
        'UPDATE cron_jobs SET status = $1, next_run = NULL WHERE id = $2', 
        ['stopped', id]
      );
      
      return await this.getJobById(id);
    } catch (error) {
      console.error(`Erreur lors de l'arrêt de la tâche ${id}:`, error);
      throw error;
    }
  }
  
  // Exécuter une tâche immédiatement
  static async runJobNow(id) {
    try {
      const job = await this.getJobById(id);
      if (!job) {
        throw new Error(`Tâche ${id} non trouvée`);
      }
      
      const scriptPath = path.resolve(job.script_path);
      console.log(`Exécution immédiate de la tâche ${job.name} (ID: ${job.id})`);
      
      // Ajouter un log de début
      logToFile(scriptPath, `========== DÉBUT DE L'EXÉCUTION MANUELLE DE LA TÂCHE: ${job.name} (ID: ${job.id}) ==========`);
      
      return new Promise((resolve, reject) => {
        exec(`node ${scriptPath}`, async (error, stdout, stderr) => {
          const now = new Date();
          let status = 'success';
          
          if (error) {
            console.error(`Erreur lors de l'exécution de la tâche ${job.id}:`, error);
            console.error(stderr);
            logToFile(scriptPath, `ERREUR: ${stderr}`);
            status = 'failed';
            reject(error);
          } else {
            console.log(`Sortie de la tâche ${job.id}:`, stdout);
            logToFile(scriptPath, stdout);
          }
          
          // Ajouter un log de fin
          logToFile(scriptPath, `========== FIN DE L'EXÉCUTION MANUELLE (STATUT: ${status}) ==========\n`);
          
          // Si la tâche est en cours d'exécution, calculer la prochaine exécution
          let nextRun = null;
          if (job.status === 'running') {
            nextRun = getNextCronRunTime(job.cron_expression);
          }
          
          // Mettre à jour la date de dernière exécution, le statut et éventuellement la prochaine exécution
          if (nextRun) {
            await pgClient.query(
              'UPDATE cron_jobs SET last_run = $1, last_status = $2, next_run = $3 WHERE id = $4',
              [now, status, nextRun, job.id]
            );
          } else {
            await pgClient.query(
              'UPDATE cron_jobs SET last_run = $1, last_status = $2 WHERE id = $3',
              [now, status, job.id]
            );
          }
          
          resolve({ ...job, last_run: now, last_status: status, next_run: nextRun });
        });
      });
    } catch (error) {
      console.error(`Erreur lors de l'exécution immédiate de la tâche ${id}:`, error);
      if (job && job.script_path) {
        logToFile(job.script_path, `ERREUR CRITIQUE: ${error.message}`);
        logToFile(job.script_path, `========== FIN DE L'EXÉCUTION MANUELLE (STATUT: failed) ==========\n`);
      }
      throw error;
    }
  }
  
  // Démarrer toutes les tâches qui étaient en cours d'exécution
  static async startAllActiveJobs() {
    try {
      console.log("🔄 Démarrage de toutes les tâches actives...");
      const result = await pgClient.query('SELECT id FROM cron_jobs WHERE status = $1', ['running']);
      
      if (result.rowCount === 0) {
        console.log("ℹ️ Aucune tâche active à démarrer");
        return 0;
      }
      
      console.log(`🔍 ${result.rowCount} tâches actives trouvées, démarrage en cours...`);
      let startedCount = 0;
      
      for (const job of result.rows) {
        try {
          console.log(`🔄 Démarrage de la tâche ID: ${job.id}...`);
          await this.startJob(job.id);
          console.log(`✅ Tâche ID: ${job.id} démarrée avec succès`);
          startedCount++;
        } catch (jobError) {
          console.error(`❌ Erreur lors du démarrage de la tâche ${job.id}:`, jobError);
          // Continuer avec les autres tâches même si une échoue
        }
      }
      
      console.log(`✅ ${startedCount}/${result.rowCount} tâches actives démarrées avec succès`);
      return startedCount;
    } catch (error) {
      console.error("❌ Erreur lors du démarrage des tâches actives:", error);
      throw error;
    }
  }
  
  // Récupérer la prochaine date d'exécution d'une tâche
  static getNextRunTime(cronExpression) {
    return getNextCronRunTime(cronExpression);
  }
  
  // Créer une tâche de test si aucune tâche n'existe
  static async createDefaultTaskIfNeeded() {
    try {
      // Vérifier s'il existe déjà des tâches
      const result = await pgClient.query('SELECT COUNT(*) as count FROM cron_jobs');
      const count = parseInt(result.rows[0].count, 10);
      
      if (count === 0) {
        console.log("🔍 Aucune tâche trouvée dans la base de données, création d'une tâche de test...");
        
        // Créer une tâche basée sur le script example.js s'il existe
        const scriptPath = path.join(process.env.SCRIPTS_PATH || '/app/scripts', 'example.js');
        
        // Vérifier si le script existe
        if (!fs.existsSync(scriptPath)) {
          console.log(`⚠️ Le script ${scriptPath} n'existe pas, impossible de créer la tâche test`);
          return;
        }
        
        // Créer la tâche
        const task = await this.createJob(
          "Tâche de test",
          scriptPath,
          "*/10 * * * *", // Toutes les 10 minutes
          "Tâche de test créée automatiquement au démarrage"
        );
        
        console.log(`✅ Tâche de test créée avec l'ID ${task.id}`);
        
        // Démarrer la tâche
        await this.startJob(task.id);
        console.log(`✅ Tâche de test démarrée avec succès`);
        
        return task;
      } else {
        console.log(`ℹ️ ${count} tâches trouvées dans la base de données, pas besoin de créer une tâche de test`);
      }
    } catch (error) {
      console.error("❌ Erreur lors de la création de la tâche de test:", error);
    }
  }
  
  // Mettre à jour la prochaine exécution pour toutes les tâches actives
  static async updateAllNextRuns() {
    try {
      console.log("🔄 Mise à jour des prochaines exécutions pour toutes les tâches actives...");
      
      // Récupérer toutes les tâches actives
      const result = await pgClient.query('SELECT id, cron_expression FROM cron_jobs WHERE status = $1', ['running']);
      
      if (result.rowCount === 0) {
        console.log("ℹ️ Aucune tâche active trouvée pour la mise à jour des prochaines exécutions");
        return;
      }
      
      let updatedCount = 0;
      
      // Pour chaque tâche active, calculer et mettre à jour la prochaine exécution
      for (const job of result.rows) {
        try {
          // Calculer la prochaine exécution
          const nextRun = getNextCronRunTime(job.cron_expression);
          
          if (nextRun) {
            // Mettre à jour la prochaine exécution dans la base de données
            await pgClient.query(
              'UPDATE cron_jobs SET next_run = $1, status = $2 WHERE id = $3',
              [nextRun, 'running', job.id]
            );
            updatedCount++;
            console.log(`✅ Prochaine exécution mise à jour pour la tâche ${job.id}: ${nextRun.toISOString()}`);
          } else {
            console.log(`⚠️ Impossible de calculer la prochaine exécution pour la tâche ${job.id}`);
          }
        } catch (jobError) {
          console.error(`❌ Erreur lors de la mise à jour de la prochaine exécution pour la tâche ${job.id}:`, jobError);
        }
      }
      
      console.log(`✅ ${updatedCount}/${result.rowCount} prochaines exécutions mises à jour`);
    } catch (error) {
      console.error("❌ Erreur lors de la mise à jour des prochaines exécutions:", error);
    }
  }
  
  // Récupérer l'historique des exécutions pour un job donné
  static async getJobExecutionHistory(id) {
    try {
      // Vérifier si le job existe
      const job = await this.getJobById(id);
      if (!job) {
        throw new Error(`Tâche ${id} non trouvée`);
      }
      
      const scriptName = path.basename(job.script_path);
      const logFilePath = path.join(LOGS_DIR, `${scriptName}.log`);
      
      // Si le fichier de logs n'existe pas, retourner un tableau vide
      if (!fs.existsSync(logFilePath)) {
        return [];
      }
      
      // Utiliser grep pour extraire les lignes de début et fin d'exécution
      const execStartPattern = "DÉBUT DE L'EXÉCUTION";
      const execEndPattern = "FIN DE L'EXÉCUTION";
      
      const executions = await new Promise((resolve, reject) => {
        exec(`grep -A 1 -B 0 "${execEndPattern}" ${logFilePath} | grep -v "^--$"`, (error, stdout, stderr) => {
          if (error && error.code !== 1) { // grep returns 1 if no matches, which is not an error for us
            reject(error);
            return;
          }
          
          // Analyser les résultats
          const lines = stdout.split('\n').filter(line => line.trim() !== '');
          const history = [];
          
          for (const line of lines) {
            if (line.includes(execEndPattern)) {
              // Extraire la date et le statut
              const match = line.match(/\[(.*?)\].*?STATUT: (.*?)\)/);
              if (match) {
                const timestamp = match[1];
                const status = match[2];
                
                history.push({
                  timestamp: new Date(timestamp),
                  status: status
                });
              }
            }
          }
          
          // Trier par date décroissante (plus récent en premier)
          history.sort((a, b) => b.timestamp - a.timestamp);
          
          resolve(history);
        });
      });
      
      return executions;
    } catch (error) {
      console.error(`Erreur lors de la récupération de l'historique d'exécution pour la tâche ${id}:`, error);
      throw error;
    }
  }
}

// Connecter à la base de données au démarrage
connectToDB();

// S'assurer que le répertoire des logs existe
ensureLogDirExists();

module.exports = { CronJob }; 