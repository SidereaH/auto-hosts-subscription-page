import yaml from 'js-yaml';
import fs from 'node:fs';

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
    getUserId,
    replaceUuidPlaceholder,
} from '@common/utils/auto-balancer/process-uuid-from-subscription';
import {
    detectStatusFlags,
    STATUS_ORDER,
    TSubscriptionHeaders,
    TSubscriptionStatus,
} from '@common/utils/subscription-status';

type TStatusRule = {
    enabled: boolean;
    templates: string[];
};

type TLoadedInjectorConfig = {
    templates: Record<string, unknown>;
    activeTemplates: string[];
    statusPriority: TSubscriptionStatus[];
    statusRules: Record<TSubscriptionStatus, TStatusRule>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim());
}

@Injectable()
export class CustomTemplateInjectorService implements OnApplicationBootstrap {
    private readonly logger = new Logger(CustomTemplateInjectorService.name);

    private readonly isEnabled: boolean;
    private readonly configPath: string;

    private loadedConfig: TLoadedInjectorConfig | null = null;

    constructor(private readonly configService: ConfigService) {
        this.isEnabled = this.configService.getOrThrow<boolean>('CUSTOM_TEMPLATES_ENABLED');
        this.configPath = this.configService.getOrThrow<string>('CUSTOM_TEMPLATES_CONFIG_PATH');
    }

    public onApplicationBootstrap(): void {
        if (!this.isEnabled) {
            this.logger.log('[CONFIG] Custom template injector is disabled');
            return;
        }

        this.loadedConfig = this.loadConfig();
        if (!this.loadedConfig) {
            this.logger.warn(
                `[CONFIG] Custom template injector cannot be initialized, fallback to original subscription`,
            );
            return;
        }

        this.logger.log('[OK] Custom template injector loaded');
    }

    public injectTemplates(
        subscriptionItems: unknown[],
        headers: TSubscriptionHeaders,
    ): unknown[] {
        if (!this.isEnabled || !this.loadedConfig) {
            return subscriptionItems;
        }

        const userId = getUserId(subscriptionItems);
        if (!userId) {
            this.logger.warn(
                'Cannot inject templates: user UUID is not found in subscription response',
            );
            return subscriptionItems;
        }

        const detectedStatus = this.detectStatus(headers);
        const templateNames = this.resolveTemplateNames(detectedStatus);

        if (templateNames.length === 0) {
            return subscriptionItems;
        }

        const preparedTemplates: unknown[] = [];
        for (const templateName of templateNames) {
            const templateObject = this.loadedConfig.templates[templateName];
            if (templateObject === undefined) {
                this.logger.warn(`Template "${templateName}" is not loaded, skip`);
                continue;
            }
            //добавляем шаблоны в массив
            preparedTemplates.push(replaceUuidPlaceholder(templateObject, userId));
        }

        if (preparedTemplates.length === 0) {
            return subscriptionItems;
        }

        return [...preparedTemplates, ...subscriptionItems];
    }

    private resolveTemplateNames(detectedStatus: TSubscriptionStatus | null): string[] {
        if (!this.loadedConfig) return [];

        if (!detectedStatus) {
            const defaultRule = this.loadedConfig.statusRules.DEFAULT;
            if (defaultRule.enabled) {
                return defaultRule.templates;
            }

            return this.loadedConfig.activeTemplates;
        }

        const rule = this.loadedConfig.statusRules[detectedStatus];
        if (!rule.enabled) {
            return [];
        }

        return rule.templates;
    }

    private detectStatus(headers: TSubscriptionHeaders): TSubscriptionStatus | null {
        if (!this.loadedConfig) return null;

        const statusFlags = detectStatusFlags(headers);

        for (const status of this.loadedConfig.statusPriority) {
            if (status === 'DEFAULT') {
                continue;
            }

            const rule = this.loadedConfig.statusRules[status];

            if (!rule.enabled) {
                continue;
            }

            if (statusFlags[status]) {
                this.logger.debug(`Detected subscription status "${status}" by headers`);
                return status;
            }
        }

        return null;
    }

    private loadConfig(): TLoadedInjectorConfig | null {
        try {
            const rawConfigBody = fs.readFileSync(this.configPath, 'utf8');
            const rawConfig = yaml.load(rawConfigBody);

            if (!isRecord(rawConfig)) {
                this.logger.error('Template injector config must be a YAML object');
                return null;
            }

            const templatesSection =
                isRecord(rawConfig.templates) || isRecord(rawConfig.templatePaths)
                    ? ((rawConfig.templates ?? rawConfig.templatePaths) as Record<string, unknown>)
                    : null;

            if (!templatesSection) {
                this.logger.error('Template injector config has no valid templates section');
                return null;
            }

            const loadedTemplates: Record<string, unknown> = {};
            for (const [templateName, templatePathValue] of Object.entries(templatesSection)) {
                if (
                    typeof templatePathValue !== 'string' ||
                    templatePathValue.trim().length === 0
                ) {
                    this.logger.warn(`Template path for "${templateName}" is invalid, skip`);
                    continue;
                }

                const templatePath = templatePathValue.trim();
                const templateRaw = fs.readFileSync(templatePath, 'utf8');
                loadedTemplates[templateName] = yaml.load(templateRaw);
            }

            const activeTemplates = toStringArray(rawConfig.activeTemplates);

            const configuredStatusPriority = toStringArray(rawConfig.statusPriority).filter(
                (status): status is TSubscriptionStatus =>
                    STATUS_ORDER.includes(status as TSubscriptionStatus),
            );
            const statusPriority =
                configuredStatusPriority.length > 0 ? configuredStatusPriority : STATUS_ORDER;

            const statusesSection = isRecord(rawConfig.statuses)
                ? (rawConfig.statuses as Record<string, unknown>)
                : {};

            const statusRules = {} as Record<TSubscriptionStatus, TStatusRule>;
            for (const status of STATUS_ORDER) {
                const statusRaw = isRecord(statusesSection[status])
                    ? (statusesSection[status] as Record<string, unknown>)
                    : {};

                statusRules[status] = {
                    enabled: statusRaw.enabled === true,
                    templates: toStringArray(statusRaw.templates),
                };
            }

            return {
                templates: loadedTemplates,
                activeTemplates,
                statusPriority,
                statusRules,
            };
        } catch (error) {
            this.logger.error(`Failed to load template injector config from ${this.configPath}`);
            this.logger.error(error);
            return null;
        }
    }
}
