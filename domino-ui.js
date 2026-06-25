// domino-ui.js — Отрисовка домино на Canvas для RobinHood P2P

const DominoUI = {
    _canvas: null,
    _ctx: null,

    init(canvasId) {
        this._canvas = document.getElementById(canvasId);
        if (!this._canvas) return;
        this._ctx = this._canvas.getContext('2d');
        this._canvas.width = Math.min(window.innerWidth - 20, 800);
        this._canvas.height = 400;
    },

    draw(state, myIndex) {
        if (!this._ctx) return;
        const ctx = this._ctx;
        const w = this._canvas.width;
        const h = this._canvas.height;

        // Фон
        ctx.fillStyle = '#1a2a1f';
        ctx.fillRect(0, 0, w, h);

        // Доска
        const boardStartX = 40;
        const boardY = h / 2 - 25;
        const tileW = 50;
        const tileH = 50;

        for (let i = 0; i < state.board.length; i++) {
            const tile = state.board[i];
            const x = boardStartX + i * (tileW + 4);
            this._drawTile(ctx, x, boardY, tileW, tileH, tile[0], tile[1]);
        }

        // Рука игрока
        const myHand = Domino.getMyHand(state, myIndex);
        const handStartX = 40;
        const handY = h - 80;

        for (let i = 0; i < myHand.length; i++) {
            const tile = myHand[i];
            const x = handStartX + i * (tileW + 4);
            this._drawTile(ctx, x, handY, tileW, tileH, tile[0], tile[1], true);
        }

        // Индикатор хода
        const turnText = state.ended 
            ? `Игра окончена! Победитель: ${state.players[state.winner]?.name || '?'}`
            : state.currentPlayer === myIndex 
                ? 'Ваш ход' 
                : `Ход: ${state.players[state.currentPlayer]?.name || '?'}`;
        
        ctx.fillStyle = state.currentPlayer === myIndex ? '#4caf50' : '#e8e2c7';
        ctx.font = '16px sans-serif';
        ctx.fillText(turnText, 40, 30);
    },

    _drawTile(ctx, x, y, w, h, left, right, clickable = false) {
        ctx.fillStyle = clickable ? '#e8d5a3' : '#c4a24b';
        ctx.strokeStyle = '#1a1f0f';
        ctx.lineWidth = 2;
        
        const r = 6;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x + w/2, y);
        ctx.lineTo(x + w/2, y + h);
        ctx.stroke();

        ctx.fillStyle = '#1a1f0f';
        this._drawDots(ctx, x, y, w/2, h, left);
        this._drawDots(ctx, x + w/2, y, w/2, h, right);
    },

    _drawDots(ctx, x, y, w, h, value) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        const dotR = 4;
        const offset = 10;

        const positions = {
            0: [],
            1: [[0, 0]],
            2: [[-offset, -offset], [offset, offset]],
            3: [[-offset, -offset], [0, 0], [offset, offset]],
            4: [[-offset, -offset], [offset, -offset], [-offset, offset], [offset, offset]],
            5: [[-offset, -offset], [offset, -offset], [0, 0], [-offset, offset], [offset, offset]],
            6: [[-offset, -offset], [offset, -offset], [-offset, 0], [offset, 0], [-offset, offset], [offset, offset]]
        };

        for (const [dx, dy] of (positions[value] || [])) {
            ctx.beginPath();
            ctx.arc(cx + dx, cy + dy, dotR, 0, Math.PI * 2);
            ctx.fill();
        }
    },

    getTileAt(x, y, state, myIndex) {
        const myHand = Domino.getMyHand(state, myIndex);
        const tileW = 50;
        const tileH = 50;
        const handStartX = 40;
        const handY = this._canvas.height - 80;

        for (let i = 0; i < myHand.length; i++) {
            const tx = handStartX + i * (tileW + 4);
            if (x >= tx && x <= tx + tileW && y >= handY && y <= handY + tileH) {
                return myHand[i];
            }
        }
        return null;
    },

    getSideAt(x, state) {
        const boardStartX = 40;
        const tileW = 50;
        const boardCenterX = boardStartX + state.board.length * (tileW + 4) / 2;
        return x < boardCenterX ? 'left' : 'right';
    }
};

if (typeof window !== 'undefined') {
    window.DominoUI = DominoUI;
}
