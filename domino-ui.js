// domino-ui.js — Отрисовка домино на Canvas для RobinHood P2P

const DominoUI = {
    _canvas: null,
    _ctx: null,

    init(canvasId) {
        this._canvas = document.getElementById(canvasId);
        if (!this._canvas) return;
        this._ctx = this._canvas.getContext('2d');
        this._resize();
        window.addEventListener('resize', () => this._resize());
    },

    _resize() {
        if (!this._canvas) return;
        const container = this._canvas.parentElement;
        const w = Math.min(container.clientWidth - 20, 800);
        const h = Math.min(window.innerHeight * 0.55, 400);
        this._canvas.width = w;
        this._canvas.height = h;
    },

    draw(state, myIndex) {
        if (!this._ctx) return;
        this._resize();
        const ctx = this._ctx;
        const w = this._canvas.width;
        const h = this._canvas.height;

        ctx.fillStyle = '#1a2a1f';
        ctx.fillRect(0, 0, w, h);

        const tileW = Math.min(50, Math.floor(w / 16));
        const tileH = tileW;
        const boardStartX = 10;
        const boardY = 10;
        const handY = h - tileH - 15;

        // Доска
        for (let i = 0; i < state.board.length; i++) {
            const tile = state.board[i];
            const x = boardStartX + i * (tileW + 2);
            if (x + tileW > w) break;
            this._drawTile(ctx, x, boardY, tileW, tileH, tile[0], tile[1]);
        }

        // Рука игрока
        const myHand = Domino.getMyHand(state, myIndex);
        const handStartX = 10;
        for (let i = 0; i < myHand.length; i++) {
            const tile = myHand[i];
            const x = handStartX + i * (tileW + 2);
            if (x + tileW > w) break;
            this._drawTile(ctx, x, handY, tileW, tileH, tile[0], tile[1], true);
        }

        // Индикатор хода
        const turnText = state.ended 
            ? `Игра окончена! Победитель: ${state.players[state.winner]?.name || '?'}`
            : state.currentPlayer === myIndex 
                ? 'Ваш ход' 
                : `Ход: ${state.players[state.currentPlayer]?.name || '?'}`;
        
        ctx.fillStyle = state.currentPlayer === myIndex ? '#4caf50' : '#e8e2c7';
        ctx.font = `${Math.max(12, Math.floor(tileW / 4))}px sans-serif`;
        ctx.fillText(turnText, 10, boardY + tileH + 20);
    },

    _drawTile(ctx, x, y, w, h, left, right, clickable = false) {
        ctx.fillStyle = clickable ? '#e8d5a3' : '#c4a24b';
        ctx.strokeStyle = '#1a1f0f';
        ctx.lineWidth = Math.max(1, Math.floor(w / 25));
        
        const r = Math.max(2, Math.floor(w / 8));
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
        const dotR = Math.max(2, Math.floor(w / 12));
        const offset = Math.max(4, Math.floor(w / 5));

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
        const tileW = Math.min(50, Math.floor(this._canvas.width / 16));
        const tileH = tileW;
        const handStartX = 10;
        const handY = this._canvas.height - tileH - 15;

        for (let i = 0; i < myHand.length; i++) {
            const tx = handStartX + i * (tileW + 2);
            if (x >= tx && x <= tx + tileW && y >= handY && y <= handY + tileH) {
                return myHand[i];
            }
        }
        return null;
    },

    getSideAt(x, state) {
        const boardStartX = 10;
        const tileW = Math.min(50, Math.floor(this._canvas.width / 16));
        const boardCenterX = boardStartX + state.board.length * (tileW + 2) / 2;
        return x < boardCenterX ? 'left' : 'right';
    }
};

if (typeof window !== 'undefined') {
    window.DominoUI = DominoUI;
}
