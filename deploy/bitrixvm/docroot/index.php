<?php
// Заглушка каталога сайта bank-app.<домен> в /home/bitrix/ext_www/.
//
// Сюда запрос доходит ТОЛЬКО если сломалось проксирование nginx → docker
// (bx/site_settings/<домен>/*.conf, см. deploy/bitrixvm/nginx/). В штатной работе
// Apache этот каталог не обслуживает вовсе: nginx отдаёт всё контейнеру.
//
// ⚠ Логики здесь нет и быть не должно. Каталог физически доступен PHP-обработчику
// портала, поэтому любой исполняемый код тут — это код, работающий рядом с боевым
// Битрикс24 и вне нашего контейнера.
//
// 503, а не 200: попадание сюда означает «сервис не обслуживается», и отвечать
// бодрым 200 значило бы соврать и мониторингу, и поисковику.
http_response_code(503);
header('Content-Type: text/plain; charset=utf-8');
header('Retry-After: 60');
header('X-Robots-Tag: noindex, nofollow');
echo "Service is temporarily unavailable\n";
