const amigoGameList = [
  {
    "id": "174",
    "label": "Book Of Zeus 2",
    "click": {
      "xMin": 1,
      "xMax": 100,
      "yMin": 20,
      "yMax": 80,
      "pickmeX": 20,
      "pickmeY": 35
    }
  },
  {
    "id": "122",
    "label": "Fortune Bags"
  },
  {
    "id": "86",
    "label": "Fruit Invaders"
  },
  {
    "id": "98",
    "label": "Piggy Coins"
  },
  {
    "id": "20",
    "label": "Blazing Crown"
  },
  {
    "id": "82",
    "label": "Super Chili"
  },
  {
    "id": "65",
    "label": "Frozen Crown"
  },
  {
    "id": "96",
    "label": "Hades Power"
  },
  {
    "id": "77",
    "label": "Sun Crown",
    "click": {
      "xMin": 20,
      "xMax": 80,
      "yMin": 20,
      "yMax": 60,
      "pickmeMode": "grid",
      "pickmePoints": [
        {
          "x": 20,
          "y": 35
        }
      ],
      "pickmeGrid": {
        "xMin": 1,
        "xMax": 50,
        "yMin": 20,
        "yMax": 80,
        "rows": 4,
        "cols": 5
      }
    }
  },
  {
    "id": "61",
    "label": "Miss Neko"
  },
  {
    "id": "117",
    "label": "3 Fortune Souls"
  },
  {
    "id": "131",
    "label": "Olympus Rivals"
  },
  {
    "id": "87",
    "label": "Voodo0Charms"
  },
  {
    "id": "123",
    "label": "3 Spirit Volcanoes"
  },
  {
    "id": "89",
    "label": "Fruits And Coins"
  },
  {
    "id": "88",
    "label": "Penguin Holidays"
  },
  {
    "id": "80",
    "label": "Cash Easy"
  },
  {
    "id": "90",
    "label": "Joker Empire"
  },
  {
    "id": "75",
    "label": "Skull Coins"
  },
  {
    "id": "73",
    "label": "Ali Baba's Bounty"
  },
  {
    "id": "92",
    "label": "Kingdom Crown"
  },
  {
    "id": "72",
    "label": "Golden Cloverfield"
  },
  {
    "id": "57",
    "label": "Burning Phoenix"
  },
  {
    "id": "55",
    "label": "Circles of Hell"
  },
  {
    "id": "181",
    "label": "loker Tricks"
  },
  {
    "id": "81",
    "label": "Olympus Blessing"
  },
  {
    "id": "66",
    "label": "Regal Crown 100"
  },
  {
    "id": "42",
    "label": "Regal Crown 25"
  },
  {
    "id": "94",
    "label": "Amigo Monkey 2"
  },
  {
    "id": "156",
    "label": "12 Fortune Signs"
  }
];

function findAmigoGame(gameId) {
  const id = String(gameId || '').trim();
  return amigoGameList.find(g => String(g.id) === id) || null;
}

module.exports = {
  amigoGameList,
  findAmigoGame
};
