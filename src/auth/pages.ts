/**
 * HTML templates for the OAuth flow pages
 */

const baseStyles = `
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }
    body {
        font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', sans-serif;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #e8e8e8;
    }
    .container {
        background: rgba(255, 255, 255, 0.05);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 20px;
        padding: 40px;
        max-width: 480px;
        width: 90%;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .logo {
        font-size: 48px;
        margin-bottom: 20px;
        text-align: center;
    }
    h1 {
        font-size: 24px;
        font-weight: 600;
        margin-bottom: 12px;
        text-align: center;
        background: linear-gradient(135deg, #fc4c02, #ff6b35);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
    }
    p {
        color: #a0a0a0;
        text-align: center;
        margin-bottom: 24px;
        line-height: 1.6;
    }
    .form-group {
        margin-bottom: 20px;
    }
    label {
        display: block;
        margin-bottom: 8px;
        font-size: 14px;
        font-weight: 500;
        color: #c0c0c0;
    }
    input {
        width: 100%;
        padding: 14px 16px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.3);
        color: #fff;
        font-size: 16px;
        transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus {
        outline: none;
        border-color: #fc4c02;
        box-shadow: 0 0 0 3px rgba(252, 76, 2, 0.2);
    }
    input::placeholder {
        color: #666;
    }
    button {
        width: 100%;
        padding: 14px 24px;
        background: linear-gradient(135deg, #fc4c02, #ff6b35);
        color: white;
        border: none;
        border-radius: 10px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 20px -5px rgba(252, 76, 2, 0.4);
    }
    button:active {
        transform: translateY(0);
    }
    .help-text {
        font-size: 13px;
        color: #888;
        margin-top: 8px;
    }
    .help-text a {
        color: #fc4c02;
        text-decoration: none;
    }
    .help-text a:hover {
        text-decoration: underline;
    }
    .success-icon {
        font-size: 64px;
        text-align: center;
        margin-bottom: 20px;
    }
    .error-icon {
        font-size: 64px;
        text-align: center;
        margin-bottom: 20px;
    }
    .icon { display: block; width: 64px; height: 64px; margin: 0 auto 20px; }
    .error-message {
        background: rgba(220, 38, 38, 0.2);
        border: 1px solid rgba(220, 38, 38, 0.3);
        border-radius: 10px;
        padding: 16px;
        margin-bottom: 20px;
        color: #fca5a5;
    }
`;


/**
 * Iconos SVG en linea, dibujados a mano.
 *
 * Sin librerias ni fuentes externas: la pagina de alta se sirve desde localhost
 * y tiene que funcionar sin conexion. Trazo en el naranja de la propia paleta
 * (#fc4c02), salvo el de error, que usa el rojo de los avisos porque un error
 * en naranja no se lee como error.
 */
const ICON_LINK = `
<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#fc4c02" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
</svg>`;

const ICON_CHECK = `
<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#fc4c02" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9.25" />
    <path d="m8 12.3 2.7 2.7L16 9.7" />
</svg>`;

const ICON_ALERT = `
<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#fca5a5" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9.25" />
    <path d="M12 7.5v5.25" />
    <path d="M12 16.25h.01" />
</svg>`;

/** Estilos de la guía de alta: pasos numerados y bloque copiable. */
const setupStyles = `
    .steps {
        text-align: left;
        margin: 0 0 24px;
        padding-left: 20px;
        line-height: 1.6;
    }
    .steps li { margin-bottom: 14px; }
    .copy-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 0 6px;
        flex-wrap: wrap;
    }
    .copy-row code {
        flex: 1 1 auto;
        min-width: 140px;
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 16px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        user-select: all;
    }
    .copy-btn {
        flex: 0 0 auto;
        width: auto;
        margin: 0;
        padding: 10px 16px;
        font-size: 14px;
        cursor: pointer;
    }
    .warn {
        font-size: 13px;
        opacity: 0.85;
        margin: 4px 0 0;
    }
    .warn code, .help-text code {
        background: rgba(0, 0, 0, 0.3);
        padding: 1px 5px;
        border-radius: 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
`;

/**
 * Setup page - form for entering Client ID and Client Secret
 */
export function setupPage(error?: string): string {
    const errorHtml = error ? `<div class="error-message">${escapeHtml(error)}</div>` : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Conectar con Strava · CRC</title>
    <style>${baseStyles}${setupStyles}</style>
</head>
<body>
    <div class="container">
        ${ICON_LINK}
        <h1>Conectar con Strava</h1>
        <p>
            Necesitas una aplicación propia en Strava. Es gratis y se tarda un minuto:
            Strava exige que cada usuario use sus propias credenciales, y así tus datos
            no pasan por ningún servidor nuestro.
        </p>
        ${errorHtml}

        <ol class="steps">
            <li>
                Abre <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a>
                y rellena el formulario de tu aplicación.
            </li>
            <li>
                En <strong>Authorization Callback Domain</strong> escribe exactamente esto:
                <div class="copy-row">
                    <code id="domain">localhost</code>
                    <button type="button" class="copy-btn" onclick="copiarDominio()">Copiar</button>
                </div>
                <p class="warn">
                    Solo <code>localhost</code>. Sin <code>http://</code> y sin <code>:8111</code>:
                    es el campo donde más gente se equivoca y Strava rechaza la conexión.
                </p>
            </li>
            <li>Copia el <strong>Client ID</strong> y el <strong>Client Secret</strong> que te dará Strava y pégalos aquí abajo.</li>
        </ol>

        <form method="POST" action="/setup">
            <div class="form-group">
                <label for="clientId">Client ID</label>
                <input type="text" id="clientId" name="clientId" placeholder="Por ejemplo: 123456" required>
            </div>
            <div class="form-group">
                <label for="clientSecret">Client Secret</label>
                <input type="password" id="clientSecret" name="clientSecret" placeholder="La cadena larga que muestra Strava" required>
            </div>
            <button type="submit">Continuar a Strava →</button>
            <p class="help-text">
                Tus credenciales se guardan solo en tu ordenador, en
                <code>~/.config/strava-mcp/config.json</code>. No se envían a ningún sitio.
            </p>
        </form>
    </div>
    <script>
        function copiarDominio() {
            const texto = document.getElementById('domain').textContent;
            const boton = document.querySelector('.copy-btn');
            const hecho = () => { boton.textContent = '¡Copiado!'; setTimeout(() => { boton.textContent = 'Copiar'; }, 1500); };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(texto).then(hecho).catch(seleccionar);
            } else {
                seleccionar();
            }
            function seleccionar() {
                // Sin portapapeles disponible: al menos se deja seleccionado.
                const rango = document.createRange();
                rango.selectNodeContents(document.getElementById('domain'));
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(rango);
                try { document.execCommand('copy'); hecho(); } catch (e) { boton.textContent = 'Copia a mano'; }
            }
        }
    </script>
</body>
</html>`;
}

/**
 * Success page - shown after successful authentication
 */
export function successPage(athleteName?: string): string {
    const greeting = athleteName
        ? `¡Hola, ${escapeHtml(athleteName)}!`
        : '¡Cuenta conectada!';
    
    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Conectado con Strava</title>
    <style>${baseStyles}</style>
</head>
<body>
    <div class="container">
        ${ICON_CHECK}
        <h1>${greeting}</h1>
        <p>Tu cuenta de Strava ya está conectada. Puedes cerrar esta pestaña y volver al chat.</p>
        <p style="font-size: 14px; color: #a0a0a0;">
            Para empezar, prueba a pedir «analiza mi última salida en bici».
        </p>
    </div>
    <script>
        // Auto-close after 5 seconds
        setTimeout(() => {
            window.close();
        }, 5000);
    </script>
</body>
</html>`;
}

/**
 * Error page - shown when something goes wrong
 */
export function errorPage(message: string, details?: string): string {
    const detailsHtml = details ? `<p class="help-text">${escapeHtml(details)}</p>` : '';
    
    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>No se pudo conectar</title>
    <style>${baseStyles}</style>
</head>
<body>
    <div class="container">
        ${ICON_ALERT}
        <h1>No se pudo conectar</h1>
        <div class="error-message">${escapeHtml(message)}</div>
        ${detailsHtml}
        <button onclick="window.location.href='/setup?reset=true'">Volver a intentarlo</button>
    </div>
</body>
</html>`;
}

/**
 * Waiting page - shown while waiting for user to authorize
 */
export function waitingPage(): string {
    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Autorizando…</title>
    <style>
        ${baseStyles}
        .spinner {
            width: 48px;
            height: 48px;
            border: 4px solid rgba(252, 76, 2, 0.2);
            border-top-color: #fc4c02;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="spinner"></div>
        <h1>Redirigiendo a Strava…</h1>
        <p>Autoriza la aplicación en la ventana de Strava.</p>
    </div>
</body>
</html>`;
}

/**
 * Credentials exist page - shown when credentials are already saved
 * Offers to continue with existing credentials or re-enter them
 */
export function credentialsExistPage(clientId: string): string {

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Conectar con Strava</title>
    <style>
        ${baseStyles}
        .btn-secondary {
            background: transparent;
            border: 1px solid rgba(255, 255, 255, 0.2);
            margin-top: 12px;
        }
        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.05);
            box-shadow: none;
            transform: none;
        }
        .credential-info {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 10px;
            padding: 12px 16px;
            margin-bottom: 24px;
            font-size: 14px;
            color: #a0a0a0;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        ${ICON_LINK}
        <h1>Conectar con Strava</h1>
        <p>Ya tienes guardadas las credenciales de tu aplicación de Strava.</p>
        <div class="credential-info">Client ID: ${escapeHtml(clientId)}</div>
        <button onclick="window.location.href='/auth'">Continuar a Strava →</button>
        <button class="btn-secondary" onclick="window.location.href='/setup?reset=true'">Introducir otras credenciales</button>
    </div>
</body>
</html>`;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text: string): string {
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, char => map[char] || char);
}
