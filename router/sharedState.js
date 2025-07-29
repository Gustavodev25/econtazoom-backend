// router/sharedState.js

/**
 * @description Este objeto armazena o estado compartilhado entre diferentes módulos do roteador.
 * Atualmente, é usado para armazenar a URL pública do ngrok para que possa ser acessada
 * pelas rotas de autenticação do Mercado Livre e da Shopee.
 */
const NGROK = { url: null };

module.exports = { NGROK };