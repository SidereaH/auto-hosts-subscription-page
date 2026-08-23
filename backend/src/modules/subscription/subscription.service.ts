import { Request, Response } from 'express';
import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Logger } from '@nestjs/common';

import { TRequestTemplateTypeKeys } from '@remnawave/backend-contract';

import {
    containsPlaceHolderFromVnext,
    getUserId,
    replaceUuidPlaceholder,
} from '@common/utils/auto-balancer';
import { parseArrayResponse } from '@common/utils/json/parse-json';
import { AxiosService } from '@common/axios/axios.service';

import { CustomTemplateInjectorService } from './custom-template-injector.service';

@Injectable()
export class SubscriptionService {
    private readonly logger = new Logger(SubscriptionService.name);

    constructor(
        private readonly axiosService: AxiosService,
        private readonly customTemplateInjectorService: CustomTemplateInjectorService,
    ) {}

    public async serveSubscriptionPage(
        clientIp: string,
        req: Request,
        res: Response,
        shortUuid: string,
        clientType?: TRequestTemplateTypeKeys,
    ): Promise<void> {
        try {
            //здесь мы получаем и отправляем нашу подписку
            const subscriptionDataResponse = await this.axiosService.getSubscription(
                clientIp,
                shortUuid,
                req.headers,
                !!clientType,
                clientType,
            );

            if (!subscriptionDataResponse) {
                res.socket?.destroy();
                return;
            }

            if (subscriptionDataResponse.headers) {
                res.set(subscriptionDataResponse.headers);
            }

            let parsedSubscription: unknown[];
            try {
                parsedSubscription = parseArrayResponse(subscriptionDataResponse.subscription);
            } catch {
                // Не JSON-массив (base64/clash и т.п. форматы) — отдаём как есть, без модификаций.
                res.status(200).send(subscriptionDataResponse.subscription);
                return;
            }

            const hasRemnawaveTemplates = parsedSubscription.some((item) =>
                containsPlaceHolderFromVnext(item),
            );

            let normalizedSubscription = parsedSubscription;
            if (hasRemnawaveTemplates) {
                const userId = getUserId(parsedSubscription);
                if (!userId) {
                    this.logger.warn('User UUID is not found in subscription response');
                } else {
                    normalizedSubscription = replaceUuidPlaceholder(parsedSubscription, userId);
                }
            }

            const responseWithTemplates = this.customTemplateInjectorService.injectTemplates(
                normalizedSubscription,
                subscriptionDataResponse.headers,
            );

            const responseBody = JSON.stringify(responseWithTemplates);
            // Remnawave's own ETag (if any) is stale once we modify the payload above
            // (UUID replace / template injection), so compute our own over the final body.
            const etag = createHash('sha256').update(responseBody).digest('hex');
            res.setHeader('ETag', `"${etag}"`);
            res.status(200).send(responseBody);
            return;
        } catch (error) {
            this.logger.error('Error in serveSubscriptionPage', error);

            res.socket?.destroy();
            return;
        }
    }
}
