/**
 * Mensajes de error de autenticación, centralizados.
 *
 * Criterio: un error debe decir QUÉ HACER, no solo qué ha fallado. "Credenciales
 * no encontradas" deja al usuario parado; "pide conectar tu cuenta y sigue el
 * navegador" lo desatasca.
 *
 * Están aquí y no repetidos en cada herramienta para que haya un único sitio que
 * cambiar cuando cambie el procedimiento de alta.
 */

/** Falta el token de acceso: el usuario aún no ha conectado su cuenta. */
export const NO_STRAVA_CONNECTION = [
    "❌ Todavía no hay ninguna cuenta de Strava conectada.",
    "",
    "Qué hacer: escribe en este chat «conecta mi cuenta de Strava».",
    "Se abrirá una página en el navegador que te guía paso a paso (necesitarás",
    "crear una aplicación gratuita en Strava, se tarda un minuto).",
    "",
    "Si crees que ya la conectaste, comprueba el estado con",
    "«¿estoy conectado a Strava?».",
].join("\n");

/** Faltan client id/secret: hay que darlos de alta. */
export const NO_CLIENT_CREDENTIALS = [
    "❌ Faltan las credenciales de tu aplicación de Strava (Client ID y Client Secret).",
    "",
    "Qué hacer: escribe «conecta mi cuenta de Strava» y el asistente te pedirá",
    "ambos datos en una página web, con el enlace para crearlos.",
    "",
    "Se guardarán solo en tu ordenador, en ~/.config/strava-mcp/config.json.",
].join("\n");

/** El token existe pero Strava lo ha rechazado. */
export const EXPIRED_CONNECTION = [
    "❌ Strava ha rechazado la conexión: el permiso ha caducado o se ha revocado.",
    "",
    "Qué hacer: escribe «conecta mi cuenta de Strava» para volver a autorizarla.",
].join("\n");
