// Script d'exemple pour le gestionnaire de tâches cron
console.log(`Exécution du script d'exemple à ${new Date().toLocaleString('fr-FR')}`);

// Définir une fonction asynchrone pour notre script
async function runExample() {
  console.log('📝 Début du traitement...');
  
  // Afficher quelques informations système
  console.log('📊 Informations système:');
  console.log(`   - Date et heure: ${new Date().toLocaleString('fr-FR')}`);
  console.log(`   - Mémoire disponible: ${Math.round(process.memoryUsage().heapTotal / (1024 * 1024))} Mo`);
  console.log(`   - Environnement: ${process.env.NODE_ENV || 'non défini'}`);
  
  // Simuler un traitement avec délai
  console.log('⏳ Simulation de traitement en cours...');
  
  for (let i = 1; i <= 5; i++) {
    // Simuler une pause pour chaque étape
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log(`   - Étape ${i}/5 terminée (${i * 20}%)`);
  }
  
  // Exemple avec un tableau de données
  console.log('📋 Traitement de données:');
  const donnees = [
    { id: 1, nom: 'Tâche A', statut: 'Terminée' },
    { id: 2, nom: 'Tâche B', statut: 'En cours' },
    { id: 3, nom: 'Tâche C', statut: 'En attente' }
  ];
  
  for (const item of donnees) {
    console.log(`   - [${item.id}] ${item.nom}: ${item.statut}`);
  }
  
  // Résumé
  console.log('✅ Traitement terminé avec succès!');
  console.log(`📌 Synthèse: ${donnees.length} éléments traités.`);
  
  return true;
}

// Exécuter notre fonction principale et gérer les erreurs
runExample()
  .then(() => {
    console.log('✅ Script terminé avec succès');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Erreur lors de l\'exécution du script:', error);
    process.exit(1);
  }); 