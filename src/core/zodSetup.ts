/**
 * Configuração global do Zod — importar ANTES de construir qualquer esquema (o Zod decide o JIT na construção).
 *
 * CSP (ciclo S1): sem JIT o Zod não chama `Function('')` para testar se eval é permitido. A CSP do build
 * público proíbe eval e cada sonda gerava uma violação de 'script-src'. A validação é idêntica, só não é compilada.
 */
import { z } from 'zod';

z.config({ jitless: true });
