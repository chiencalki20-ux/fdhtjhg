const vaGameList = [
  { id: '1010', label: 'A Ira de Zeus' },
  { id: '1003', label: 'Apollo Chama Solar' },
  { id: '1024', label: 'DEUSA ATENA 2048' },
  { id: '1008', label: 'Rainha da Recompensa' },
  { id: '416', label: 'O Tesouro do Dragão 3 M' },
  { id: '1006', label: 'Thor Deluxe' },
  { id: '491', label: 'Carnaval do Joker 4096' },
  { id: '472', label: 'Mito Asteca' },
  { id: '482', label: 'Deusa Inca' },
  { id: '473', label: 'Potes da Fortuna' },
  { id: '475', label: 'Três Tesouros Egípcios' },
  { id: '470', label: 'Magia Dragão' },
  { id: '462', label: 'Piñata' },
  { id: '471', label: 'Ganho do Mahjong Auto-Sorteado 4' },
  { id: '469', label: 'Inca Zuma' },
  { id: '422', label: 'Lenda da Fenix' },
  { id: '453', label: 'Gato da Sorte' },
  { id: '441', label: 'Gala de Gemas' },
  { id: '417', label: 'Saga Candy Crush' },
  { id: '435', label: 'Reino do Dragão de Fogo' }
];

function findVaGame(gameId) {
  const id = String(gameId || '').trim();
  return vaGameList.find(g => String(g.id) === id) || null;
}

module.exports = {
  vaGameList,
  findVaGame
};
