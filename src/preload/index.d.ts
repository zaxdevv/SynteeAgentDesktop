declare const synteeAPI: {
    window: {
        hide: () => Promise<any>;
        minimize: () => Promise<any>;
        show: () => Promise<any>;
    };
    settings: {
        get: (key: string) => Promise<any>;
        set: (key: string, value: unknown) => Promise<any>;
        getAll: () => Promise<any>;
    };
    bgImage: {
        save: (data: Uint8Array, ext: string) => Promise<string | null>;
        list: () => Promise<{
            src: string;
            name: string;
            size: number;
            mtime: number;
        }[]>;
        load: (src: string) => Promise<string | null>;
        delete: (src: string) => Promise<boolean>;
        clear: () => Promise<boolean>;
    };
    sound: {
        save: (data: Uint8Array, ext: string, originalName?: string) => Promise<string | null>;
        list: () => Promise<{
            id: string;
            name: string;
            size: number;
            mtime: number;
        }[]>;
        load: (id: string) => Promise<string | null>;
        delete: (id: string) => Promise<boolean>;
    };
    auth: {
        login: () => Promise<any>;
        isLoggedIn: () => Promise<boolean>;
        me: () => Promise<any>;
        logout: () => Promise<any>;
        onLoggedIn: (cb: () => void) => () => Electron.IpcRenderer;
        onLoggedOut: (cb: () => void) => () => Electron.IpcRenderer;
        onLoginError: (cb: (err: {
            message: string;
        }) => void) => () => Electron.IpcRenderer;
    };
    profile: {
        update: (payload: {
            display_name?: string | null;
            avatar_url?: string | null;
            username?: string;
        }) => Promise<any>;
        checkUsername: (username: string) => Promise<any>;
        changePassword: (currentPassword: string, newPassword: string) => Promise<any>;
        listApiKeys: () => Promise<any>;
        createApiKey: (name: string) => Promise<any>;
        deleteApiKey: (keyId: string) => Promise<any>;
    };
    gateway: {
        fetchModels: () => Promise<any>;
        fetchModelStatus: () => Promise<any>;
        fetchProviderStatus: () => Promise<any>;
        isAvailable: () => Promise<boolean>;
    };
    billing: {
        balance: () => Promise<any>;
        transactions: (params?: {
            limit?: number;
            offset?: number;
        }) => Promise<any>;
        summary: (params?: {
            hours?: number;
        }) => Promise<any>;
        timeseries: (params?: {
            hours?: number;
        }) => Promise<any>;
        breakdown: (params?: {
            hours?: number;
            by?: "model" | "provider" | "status" | "format";
        }) => Promise<any>;
        plan: () => Promise<any>;
        openTopup: () => Promise<any>;
    };
    messenger: {
        connect: () => Promise<{
            ok: boolean;
        }>;
        disconnect: () => Promise<{
            ok: boolean;
        }>;
        wsSend: (envelope: {
            type: string;
            data: Record<string, unknown>;
        }) => Promise<{
            ok: boolean;
        }>;
        setActive: (conversationId: string | null) => Promise<{
            ok: boolean;
        }>;
        onEvent: (cb: (envelope: {
            type: string;
            data: Record<string, unknown>;
        }) => void) => () => Electron.IpcRenderer;
        friends: {
            list: () => Promise<any>;
            requests: () => Promise<any>;
            search: (username: string) => Promise<any>;
            request: (username: string) => Promise<any>;
            accept: (userId: string) => Promise<any>;
            decline: (userId: string) => Promise<any>;
            unfriend: (userId: string) => Promise<any>;
            block: (userId: string) => Promise<any>;
            unblock: (userId: string) => Promise<any>;
            hide: (userId: string) => Promise<any>;
            unhide: (userId: string) => Promise<any>;
        };
        conversations: {
            list: () => Promise<any>;
            create: (otherId: string) => Promise<any>;
        };
        messages: {
            list: (conversationId: string, cursor?: string | null, limit?: number) => Promise<any>;
            send: (conversationId: string, payload: {
                message_type?: "text" | "code" | "image" | "file";
                body?: string | null;
                attachment_token?: string | null;
                attachment_filename?: string | null;
                attachment_mime?: string | null;
                attachment_size?: number | null;
                reply_to_id?: string | null;
            }) => Promise<any>;
            read: (conversationId: string, messageId: string) => Promise<any>;
            typing: (conversationId: string) => Promise<any>;
            react: (conversationId: string, messageId: string, emoji: string) => Promise<any>;
            delete: (conversationId: string, messageId: string) => Promise<any>;
            search: (q: string, conversationId?: string) => Promise<any>;
        };
        attachments: {
            upload: (file: File) => Promise<any>;
            fetch: (conversationId: string, messageId: string) => Promise<any>;
        };
        shares: {
            shareChat: (chatId: string, recipientId: string) => Promise<{
                ok: true;
                share: unknown;
            } | {
                error: string;
            }>;
            importShare: (shareId: string) => Promise<{
                chatId: string;
                messages: unknown[];
                title: string;
            } | {
                error: string;
            }>;
        };
        global: {
            list: (cursor?: string | null, limit?: number) => Promise<any>;
            send: (payload: {
                message_type?: "text" | "code" | "image" | "file";
                body?: string | null;
                attachment_token?: string | null;
                attachment_filename?: string | null;
                attachment_mime?: string | null;
                attachment_size?: number | null;
                reply_to_id?: string | null;
            }) => Promise<any>;
            read: (messageId: string) => Promise<any>;
            unread: () => Promise<any>;
            react: (messageId: string, emoji: string) => Promise<any>;
            delete: (messageId: string) => Promise<any>;
            typing: () => Promise<any>;
            fetchAttachment: (messageId: string) => Promise<any>;
            shareChat: (chatId: string) => Promise<{
                ok: true;
                message: unknown;
            } | {
                error: string;
            }>;
        };
    };
    system: {
        info: () => Promise<any>;
        logError: (message: string, stack?: string) => Promise<any>;
    };
    overlay: {
        show: () => Promise<any>;
        hide: () => Promise<any>;
        getDisplays: () => Promise<any>;
        captureScreen: () => Promise<any>;
        analyze: (params: {
            imageBase64: string;
            prompt: string;
            action: string;
        }) => Promise<any>;
        saveScreenshot: (base64: string) => Promise<any>;
    };
    spotlight: {
        show: () => Promise<any>;
        hide: () => Promise<any>;
        expand: () => Promise<any>;
        collapse: () => Promise<any>;
    };
    trayMenu: {
        hide: () => Promise<any>;
        action: (actionId: string) => Promise<any>;
        getMeta: () => Promise<{
            version: string;
        }>;
    };
    chat: {
        create: (incognito?: boolean, mode?: "code" | "work", projectId?: string) => Promise<any>;
        getAll: () => Promise<any>;
        getMessages: (chatId: string) => Promise<any>;
        getMessagesPage: (chatId: string, limit?: number, beforeCreatedAt?: number, beforeId?: string) => Promise<{
            messages: import("../../shared/types").Message[];
            hasMore: boolean;
        }>;
        send: (params: {
            chatId: string;
            content: string;
            displayContent?: string;
            slashCommand?: {
                name: string;
                args: string;
            };
            incognito?: boolean;
            userMsgId?: string;
            planningMode?: boolean;
            askMode?: boolean;
            imageMode?: boolean;
            mode?: "code" | "work";
            oneShotSkill?: {
                name: string;
                instructions: string;
            };
            oneShotAllowedTools?: string[];
            oneShotMode?: "ask" | "plan" | "code";
            attachments?: import("../../shared/types").Attachment[];
        }) => Promise<any>;
        delete: (chatId: string) => Promise<any>;
        rename: (chatId: string, title: string) => Promise<any>;
        pin: (messageId: string) => Promise<any>;
        unpin: (messageId: string) => Promise<any>;
        reloadClient: () => Promise<any>;
        stop: (chatId?: string) => Promise<any>;
        getLiveState: (chatId: string) => Promise<any>;
        archive: (chatId: string, archived: boolean) => Promise<any>;
        pinChat: (chatId: string, pinned: boolean) => Promise<any>;
        setColor: (chatId: string, color: string | null) => Promise<any>;
        duplicate: (chatId: string) => Promise<any>;
        export: (chatId: string, format: "txt" | "md") => Promise<any>;
        getQueue: (chatId: string) => Promise<any>;
        queueRemove: (chatId: string, queueId: string) => Promise<any>;
        queueReorder: (chatId: string, queueIds: string[]) => Promise<any>;
        getSessionTimeline: (chatId: string) => Promise<any>;
        getLastTurnFilesChanged: (chatId: string) => Promise<any>;
        rewindTo: (chatId: string, userMessageId: string) => Promise<any>;
        redo: (chatId: string, rewindMessageId: string) => Promise<any>;
        canRedo: (chatId: string, rewindMessageId: string) => Promise<any>;
        compact: (chatId: string) => Promise<any>;
        fork: (chatId: string, title?: string) => Promise<any>;
        snapshotCreate: (chatId: string, name: string) => Promise<any>;
        snapshotList: (chatId: string) => Promise<any>;
        sideSend: (params: {
            parentChatId: string;
            content: string;
            sideMessages: unknown[];
        }) => Promise<any>;
        getModes: (chatId: string) => Promise<{
            planningMode: boolean;
            imageMode: boolean;
            askMode: boolean;
        }>;
        setModes: (chatId: string, modes: {
            planningMode: boolean;
            imageMode: boolean;
            askMode: boolean;
        }) => Promise<any>;
        getDraft: (chatId: string) => Promise<string>;
        setDraft: (chatId: string, draft: string) => Promise<any>;
        getInputHistory: (chatId: string) => Promise<string[]>;
    };
    projects: {
        pickWorkdir: () => Promise<any>;
        pickNewWorkdir: () => Promise<any>;
        create: (workdir: string) => Promise<any>;
        getAll: () => Promise<any>;
        rename: (id: string, name: string) => Promise<any>;
        delete: (id: string) => Promise<any>;
        getById: (id: string) => Promise<any>;
        touch: (id: string) => Promise<any>;
        setVerificationCommand: (id: string, command: string | null) => Promise<any>;
    };
    fastContext: {
        getStatus: (projectId: string) => Promise<any>;
        reindex: (projectId: string) => Promise<any>;
        clearIndex: (projectId: string) => Promise<any>;
        setActive: (projectId: string | null) => Promise<any>;
        onProgress: (cb: (data: {
            projectId: string;
            stage: string;
            detail?: string;
            filesProcessed?: number;
            filesTotal?: number;
        }) => void) => () => Electron.IpcRenderer;
        onUpdated: (cb: (projectId: string) => void) => () => Electron.IpcRenderer;
    };
    memory: {
        getAll: (filter?: unknown) => Promise<any>;
        save: (entry: unknown) => Promise<any>;
        delete: (id: string) => Promise<any>;
        search: (params: unknown) => Promise<any>;
        pin: (id: string, pinned: boolean) => Promise<any>;
        setImportance: (id: string, importance: number) => Promise<any>;
        stats: () => Promise<any>;
        prune: (maxAgeDays?: number, minImportance?: number) => Promise<any>;
        reindex: () => Promise<any>;
        extractOutcomes: (params?: {
            chatId?: string;
            projectId?: string;
        }) => Promise<any>;
        pruneAgentLogs: (maxAgeDays?: number) => Promise<any>;
        getCategories: (projectId?: string) => Promise<any>;
        createCategory: (input: unknown) => Promise<any>;
        deleteCategory: (id: string) => Promise<any>;
    };
    graph: {
        get: (projectId: string, opts?: unknown) => Promise<any>;
        stats: (projectId: string) => Promise<any>;
        rebuild: (projectId: string) => Promise<any>;
        deleteNode: (id: string) => Promise<any>;
        pinNode: (id: string, pinned: boolean) => Promise<any>;
        pruneIsolated: (projectId?: string) => Promise<any>;
    };
    agent: {
        run: (query: string) => Promise<any>;
        cancel: (id?: string) => Promise<any>;
        list: () => Promise<any>;
        get: (id: string) => Promise<any>;
        children: (parentId: string) => Promise<any>;
        clearChat: (chatId: string) => Promise<any>;
        getSettings: () => Promise<any>;
        setSettings: (s: unknown) => Promise<any>;
        onConfirm: (cb: (data: {
            reqId: string;
            toolName: string;
            args: unknown;
            dangerLevel?: string;
            dangerReason?: string;
            previewDiff?: string;
        }) => void) => (_: unknown, data: unknown) => void;
        offConfirm: (wrapper: (...args: unknown[]) => void) => void;
        confirmResponse: (reqId: string, approved: boolean) => void;
        onQuestion: (cb: (data: {
            reqId: string;
            questions: unknown[];
            chatId: string;
            msgId: string;
        }) => void) => (_: unknown, data: unknown) => void;
        offQuestion: (wrapper: (...args: unknown[]) => void) => void;
        questionResponse: (reqId: string, answers: unknown[]) => void;
    };
    providers: {
        getAll: () => Promise<any>;
        save: (provider: unknown) => Promise<any>;
        delete: (id: string) => Promise<any>;
        testKey: (providerId: string) => Promise<any>;
        fetchModels: (providerId: string) => Promise<any>;
    };
    context: {
        estimateInput: (params: {
            text: string;
        }) => Promise<any>;
        calculate: (chatId: string) => Promise<any>;
    };
    models: {
        getAll: () => Promise<any>;
        saveCustom: (model: unknown) => Promise<any>;
        deleteCustom: (modelId: string, providerId: string) => Promise<any>;
        getAssignments: () => Promise<any>;
        setAssignment: (assignment: unknown) => Promise<any>;
        getParams: () => Promise<any>;
        setParams: (params: unknown) => Promise<any>;
        getRecent: () => Promise<any>;
        addRecent: (modelId: string, providerId: string) => Promise<any>;
        getPinned: () => Promise<any>;
        togglePin: (modelId: string, providerId: string) => Promise<any>;
    };
    on: (channel: string, callback: (...args: unknown[]) => void) => () => Electron.IpcRenderer;
    off: (channel: string, _callback: (...args: unknown[]) => void) => void;
    once: (channel: string, callback: (...args: unknown[]) => void) => void;
    debug: {
        streamTest: () => Promise<any>;
        openDevTools: () => Promise<any>;
    };
    image: {
        generate: (params: unknown) => Promise<any>;
        getSettings: () => Promise<any>;
        setSettings: (s: unknown) => Promise<any>;
    };
    shell: {
        openPath: (path: string) => Promise<any>;
        getExtensionsPaths: () => Promise<any>;
    };
    pty: {
        detectShells: () => Promise<any>;
        create: (params: {
            chatId: string;
            shell: string;
            cwd?: string;
            source?: "user" | "agent";
            title?: string;
        }) => Promise<any>;
        list: (chatId: string) => Promise<any>;
        write: (sessionId: string, data: string) => Promise<any>;
        resize: (sessionId: string, cols: number, rows: number) => Promise<any>;
        kill: (sessionId: string) => Promise<any>;
        consumePreMount: (sessionId: string) => Promise<any>;
        getMeta: (sessionId: string) => Promise<any>;
    };
    fs: {
        getWorkdir: (chatId: string) => Promise<any>;
        listDirectory: (params: {
            root: string;
            relPath?: string;
            maxEntries?: number;
        }) => Promise<any>;
        readFile: (params: {
            root: string;
            relPath: string;
            maxBytes?: number;
        }) => Promise<any>;
    };
    git: {
        status: (workdir: string) => Promise<any>;
        diff: (params: {
            workdir: string;
            file?: string;
            staged?: boolean;
        }) => Promise<any>;
        show: (params: {
            workdir: string;
            hash: string;
            file?: string;
        }) => Promise<any>;
        log: (params: {
            workdir: string;
            limit?: number;
        }) => Promise<any>;
        branch: (workdir: string) => Promise<any>;
        isRepo: (workdir: string) => Promise<any>;
    };
    skills: {
        getAll: (params?: {
            projectId?: string;
        }) => Promise<any>;
        setState: (params: {
            skillId: string;
            state: unknown;
            source: "builtin" | "user" | "project";
        }) => Promise<any>;
        reload: () => Promise<any>;
        getActive: (params: {
            chatId: string;
            isIncognito?: boolean;
        }) => Promise<any>;
        installFromUrl: (params: {
            url: string;
            scope: "global" | {
                workdir: string;
            };
        }) => Promise<any>;
    };
    commands: {
        list: (params?: {
            projectWorkdir?: string;
        }) => Promise<any>;
        reload: () => Promise<any>;
    };
    mcp: {
        getAll: (params?: {
            projectId?: string;
        }) => Promise<any>;
        getActiveForChat: (params: {
            chatId: string;
            isIncognito?: boolean;
        }) => Promise<any>;
        save: (config: unknown) => Promise<any>;
        delete: (id: string) => Promise<any>;
        connect: (serverId: string) => Promise<any>;
        disconnect: (serverId: string) => Promise<any>;
        reconnect: (serverId: string) => Promise<any>;
        setServerState: (params: {
            serverId: string;
            enabled?: boolean;
            scope?: unknown;
        }) => Promise<any>;
        setToolState: (params: {
            serverId: string;
            toolFullName: string;
            state: unknown;
        }) => Promise<any>;
        installDirect: (params: {
            name: string;
            transport: "stdio" | "sse" | "streamable-http";
            command?: string;
            args?: string[];
            env?: Record<string, string>;
            url?: string;
            headers?: Record<string, string>;
            scope: "global" | {
                workdir: string;
            };
        }) => Promise<any>;
        updateServer: (params: {
            serverId: string;
            env?: Record<string, string>;
            args?: string[];
        }) => Promise<any>;
    };
    marketplace: {
        searchMcp: (params: {
            query: string;
            limit?: number;
            cursor?: string;
        }) => Promise<any>;
        cancelMcpSearch: () => Promise<any>;
        searchSkills: (params: {
            query: string;
            page?: number;
            perPage?: number;
        }) => Promise<any>;
        cancelSkillsSearch: () => Promise<any>;
        getSkillReadme: (params: {
            fullName: string;
        }) => Promise<any>;
        buildMcpInstruction: (params: unknown) => Promise<any>;
        buildSkillInstruction: (params: unknown) => Promise<any>;
        buildMcpUrlInstruction: (params: {
            url: string;
            scope: "global" | {
                workdir: string;
            };
        }) => Promise<any>;
    };
    mentions: {
        search: (params: {
            workdir?: string;
            query: string;
            limit?: number;
        }) => Promise<any>;
        startIndexing: (workdir: string) => Promise<any>;
        stopIndexing: (workdir: string) => Promise<any>;
    };
    attachments: {
        readFile: (params: {
            path: string;
        }) => Promise<any>;
        saveImageFromBase64: (params: {
            chatId: string;
            base64: string;
            mime?: string;
            suggestedName?: string;
        }) => Promise<any>;
        saveFileFromPath: (params: {
            chatId: string;
            sourcePath: string;
        }) => Promise<any>;
        deleteFile: (params: {
            path: string;
        }) => Promise<any>;
        pickFile: () => Promise<any>;
        getPathForFile: (file: File) => string;
    };
    draft: {
        getAttachments: (chatId: string) => Promise<any>;
        setAttachments: (chatId: string, attachments: import("../../shared/types").Attachment[]) => Promise<any>;
        clearAttachments: (chatId: string) => Promise<any>;
    };
    updates: {
        check: () => Promise<import("../../shared/types").UpdateState>;
        getStatus: () => Promise<import("../../shared/types").UpdateState>;
        getHistory: (params?: {
            channel?: string;
            limit?: number;
        }) => Promise<import("../../shared/types").ChangelogEntry[]>;
        dismiss: (version: string) => Promise<import("../../shared/types").UpdateState>;
        quitAndInstall: () => Promise<import("../../shared/types").QuitAndInstallResult>;
        onStateChanged: (cb: (state: import("../../shared/types").UpdateState) => void) => () => Electron.IpcRenderer;
    };
};
export type SynteeAPI = typeof synteeAPI;
export {};
