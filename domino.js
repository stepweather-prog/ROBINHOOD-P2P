// domino.js — Домино для RobinHood P2P
// Тет-а-тет и шайки. Без сервера. Без зависимостей.

const Domino = {
    // Генерация колоды: 28 костяшек [0,0]..[6,6]
    generateDeck() {
        const deck = [];
        for (let i = 0; i <= 6; i++) {
            for (let j = i; j <= 6; j++) {
                deck.push([i, j]);
            }
        }
        return deck;
    },

    // Перемешивание с использованием seed (детерминированное — одинаковый seed = одинаковая раздача)
    shuffle(deck, seed) {
        const rng = this._seededRandom(seed);
        const shuffled = [...deck];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    },

    // Простой линейный конгруэнтный генератор
    _seededRandom(seed) {
        let s = seed;
        return function() {
            s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
            return (s >>> 0) / 0xFFFFFFFF;
        };
    },

    // Создание новой игры
    createGame(seed, players) {
        const deck = this.shuffle(this.generateDeck(), seed);
        const state = {
            seed,
            deck,
            players: players.map((name, i) => ({
                name,
                hand: [],
                index: i
            })),
            board: [],
            turn: 0,
            currentPlayer: 0,
            passed: [],
            scores: players.map(() => 0),
            ended: false,
            winner: null
        };

        // Раздача по 7 костяшек
        for (const player of state.players) {
            player.hand = state.deck.splice(0, 7);
        }

        // Первый ход: у кого дубль 6:6, или самый большой дубль, или первый игрок
        state.currentPlayer = this._firstPlayer(state);
        return state;
    },

    // Определение первого игрока (по наибольшему дублю)
    _firstPlayer(state) {
        let best = -1;
        let playerIndex = 0;
        for (let i = 0; i < state.players.length; i++) {
            for (const tile of state.players[i].hand) {
                if (tile[0] === tile[1] && tile[0] > best) {
                    best = tile[0];
                    playerIndex = i;
                }
            }
        }
        return playerIndex;
    },

    // Проверка: можно ли положить tile на указанную сторону
    isValidMove(state, tile, side) {
        if (state.board.length === 0) return true;
        const leftEnd = state.board[0][0];
        const rightEnd = state.board[state.board.length - 1][1];
        const target = side === 'left' ? leftEnd : rightEnd;
        return tile[0] === target || tile[1] === target;
    },

    // Размещение костяшки — мутирует state, возвращает true если успешно
    placeTile(state, tile, side) {
        if (!this.isValidMove(state, tile, side)) return false;

        if (state.board.length === 0) {
            // Первый ход — кладём как есть
            state.board.push([tile[0], tile[1]]);
        } else if (side === 'left') {
            const target = state.board[0][0];
            if (tile[1] === target) {
                state.board.unshift([tile[0], tile[1]]);
            } else {
                state.board.unshift([tile[1], tile[0]]);
            }
        } else {
            const target = state.board[state.board.length - 1][1];
            if (tile[0] === target) {
                state.board.push([tile[0], tile[1]]);
            } else {
                state.board.push([tile[1], tile[0]]);
            }
        }

        // Убираем костяшку из руки игрока
        const player = state.players[state.currentPlayer];
        player.hand = player.hand.filter(t => !(t[0] === tile[0] && t[1] === tile[1]));

        // Сбрасываем счётчик пасов
        state.passed = [];
        return true;
    },

    // Пропуск хода
    pass(state) {
        state.passed.push(state.currentPlayer);
        this._nextTurn(state);
    },

    // Переход хода к следующему игроку
    _nextTurn(state) {
        const totalPlayers = state.players.length;
        let next = (state.currentPlayer + 1) % totalPlayers;
        state.currentPlayer = next;
        state.turn++;
    },

    // Проверка окончания игры. Возвращает true если игра закончена.
    checkEnd(state) {
        // Рыба: все игроки пропустили ход подряд
        if (state.passed.length >= state.players.length) {
            state.ended = true;
            state.winner = this._winnerByPoints(state);
            return true;
        }

        // У кого-то кончились костяшки
        for (const player of state.players) {
            if (player.hand.length === 0) {
                state.ended = true;
                state.winner = player.index;
                return true;
            }
        }

        return false;
    },

    // Определение победителя по очкам (при рыбе — у кого меньше сумма на руке)
    _winnerByPoints(state) {
        let minSum = Infinity;
        let winner = 0;
        for (const player of state.players) {
            const sum = player.hand.reduce((s, t) => s + t[0] + t[1], 0);
            if (sum < minSum) {
                minSum = sum;
                winner = player.index;
            }
        }
        return winner;
    },

    // Публичное состояние игры (без рук других игроков)
    getPublicState(state) {
        return {
            board: state.board,
            currentPlayer: state.currentPlayer,
            players: state.players.map(p => ({
                name: p.name,
                handSize: p.hand.length,
                index: p.index
            })),
            turn: state.turn,
            ended: state.ended,
            winner: state.winner,
            passed: state.passed
        };
    },

    // Рука конкретного игрока
    getMyHand(state, playerIndex) {
        return state.players[playerIndex]?.hand || [];
    }
};

if (typeof window !== 'undefined') {
    window.Domino = Domino;
}
