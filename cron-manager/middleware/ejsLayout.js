/**
 * Middleware pour intégrer le layout EJS
 */
const ejsLayout = (req, res, next) => {
  // Sauvegarde de la fonction render originale
  const originalRender = res.render;
  
  // Remplacer par notre fonction qui utilise le layout
  res.render = function(view, options, callback) {
    // Si options est une fonction (callback), l'ajuster
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    
    // S'assurer que options est un objet
    options = options || {};
    
    // Ajouter le body à options pour le layout
    const renderOptions = Object.assign({}, options, {
      body: null // Sera rempli avec le contenu de la vue
    });
    
    // Rendre d'abord la vue demandée
    originalRender.call(this, view, options, (err, html) => {
      if (err) return callback ? callback(err) : next(err);
      
      // Stocker le HTML généré dans body
      renderOptions.body = html;
      
      // Rendre le layout avec le body
      originalRender.call(this, 'layout', renderOptions, callback);
    });
  };
  
  next();
};

module.exports = ejsLayout; 