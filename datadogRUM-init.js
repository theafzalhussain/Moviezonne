import { datadogRum } from '@datadog/browser-rum';

datadogRum.init({
    applicationId: '2d98ba56-1b76-4b3e-9591-e6964fe2733c',
    clientToken: 'pub4dbf2c26e71ae61cfd49507556566886',
    site: 'us5.datadoghq.com',
    service: '<SERVICE_NAME>',
    env: '<ENV_NAME>',				// e.g. 'prod', 'staging-1', 'dev'
    version: '<VERSION_NUMBER>',	// e.g. '1.0.0'
    sessionSampleRate: 100,			// capture 100% of sessions
    sessionReplaySampleRate: 20,	// capture 20% of sessions with replay
    trackResources: true,			// Enable Resource tracking
    trackUserInteractions: true,	// Enable Action tracking
    trackLongTasks: true,			// Enable Long Tasks tracking

    // ----- Recommended Options -----
    // allowedTracingUrls: '<BACKEND_URL>',		// Enable distributed tracing
    // defaultPrivacyLevel: 'mask-user-input',	// 'mask-user-input' | 'allow' | 'mask'
});