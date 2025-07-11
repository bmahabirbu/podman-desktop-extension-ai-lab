/**********************************************************************
 * Copyright (C) 2024-2025 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import { env, version } from '@podman-desktop/api';
import { satisfies, minVersion, coerce } from 'semver';
import type {
  ExtensionContext,
  TelemetryLogger,
  WebviewPanel,
  WebviewPanelOnDidChangeViewStateEvent,
} from '@podman-desktop/api';
import { RpcExtension } from '@shared/messages/MessageProxy';
import { StudioApiImpl } from './studio-api-impl';
import { ApplicationManager } from './managers/application/applicationManager';
import { GitManager } from './managers/gitManager';
import { TaskRegistry } from './registries/TaskRegistry';
import { CatalogManager } from './managers/catalogManager';
import { ModelsManager } from './managers/modelsManager';
import { ContainerRegistry } from './registries/ContainerRegistry';
import { PodmanConnection } from './managers/podmanConnection';
import { LocalRepositoryRegistry } from './registries/LocalRepositoryRegistry';
import { InferenceManager } from './managers/inference/inferenceManager';
import { PlaygroundV2Manager } from './managers/playgroundV2Manager';
import { SnippetManager } from './managers/SnippetManager';
import { CancellationTokenRegistry } from './registries/CancellationTokenRegistry';
import { engines } from '../package.json';
import { BuilderManager } from './managers/recipes/BuilderManager';
import { PodManager } from './managers/recipes/PodManager';
import { initWebview } from './webviewUtils';
import { LlamaCppPython } from './workers/provider/LlamaCppPython';
import { InferenceProviderRegistry } from './registries/InferenceProviderRegistry';
import { ConfigurationRegistry } from './registries/ConfigurationRegistry';
import { RecipeManager } from './managers/recipes/RecipeManager';
import { GPUManager } from './managers/GPUManager';
import { WhisperCpp } from './workers/provider/WhisperCpp';
import { ApiServer } from './managers/apiServer';
import { InstructlabManager } from './managers/instructlab/instructlabManager';
import { InstructlabApiImpl } from './instructlab-api-impl';
import { NavigationRegistry } from './registries/NavigationRegistry';
import type { StudioAPI } from '@shared/StudioAPI';
import { STUDIO_API_CHANNEL } from '@shared/StudioAPI';
import type { InstructlabAPI } from '@shared/InstructlabAPI';
import { INSTRUCTLAB_API_CHANNEL } from '@shared/InstructlabAPI';
import { ModelHandlerRegistry } from './registries/ModelHandlerRegistry';
import { URLModelHandler } from './models/URLModelHandler';
import { HuggingFaceModelHandler } from './models/HuggingFaceModelHandler';
import { LlamaStackApiImpl } from './llama-stack-api-impl';
import { LLAMA_STACK_API_CHANNEL, type LlamaStackAPI } from '@shared/LlamaStackAPI';
import { LlamaStackManager } from './managers/llama-stack/llamaStackManager';
import { OpenVINO } from './workers/provider/OpenVINO';
import { McpServerManager } from './managers/playground/McpServerManager';
import os from 'node:os';

export class Studio {
  readonly #extensionContext: ExtensionContext;

  /**
   * Webview panel used by AI Lab
   */
  #panel: WebviewPanel | undefined;

  /**
   * API related classes
   */
  #rpcExtension: RpcExtension | undefined;
  #studioApi: StudioApiImpl | undefined;
  #instructlabApi: InstructlabApiImpl | undefined;
  #llamaStackApi: LlamaStackApiImpl | undefined;

  #localRepositoryRegistry: LocalRepositoryRegistry | undefined;
  #catalogManager: CatalogManager | undefined;
  #modelsManager: ModelsManager | undefined;
  #telemetry: TelemetryLogger | undefined;
  #inferenceManager: InferenceManager | undefined;
  #podManager: PodManager | undefined;
  #builderManager: BuilderManager | undefined;
  #containerRegistry: ContainerRegistry | undefined;
  #podmanConnection: PodmanConnection | undefined;
  #taskRegistry: TaskRegistry | undefined;
  #cancellationTokenRegistry: CancellationTokenRegistry | undefined;
  #snippetManager: SnippetManager | undefined;
  #mcpServerManager: McpServerManager | undefined;
  #playgroundManager: PlaygroundV2Manager | undefined;
  #applicationManager: ApplicationManager | undefined;
  #recipeManager: RecipeManager | undefined;
  #inferenceProviderRegistry: InferenceProviderRegistry | undefined;
  #configurationRegistry: ConfigurationRegistry | undefined;
  #gpuManager: GPUManager | undefined;
  #navigationRegistry: NavigationRegistry | undefined;
  #instructlabManager: InstructlabManager | undefined;
  #llamaStackManager: LlamaStackManager | undefined;

  constructor(readonly extensionContext: ExtensionContext) {
    this.#extensionContext = extensionContext;
  }

  private checkVersion(): boolean {
    if (!version) return false;

    const current = coerce(version);
    if (!current) return false;

    return satisfies(current, engines['podman-desktop']);
  }

  public async activate(): Promise<void> {
    console.log('starting AI Lab extension');
    this.#telemetry = env.createTelemetryLogger();

    /**
     * Ensure the running version of podman is compatible with
     * our minimum requirement
     */
    if (!this.checkVersion()) {
      const min = minVersion(engines['podman-desktop']) ?? { version: 'unknown' };
      const current = version ?? 'unknown';
      this.#telemetry.logError('start.incompatible', {
        version: current,
        message: `error activating extension on version below ${min.version}`,
      });
      throw new Error(
        `Extension is not compatible with Podman Desktop version below ${min.version}. Current ${current}`,
      );
    }

    /**
     * Storage directory for the extension provided by podman desktop
     */
    const appUserDirectory = this.extensionContext.storagePath;

    this.#telemetry.logUsage('start');

    /**
     * The AI Lab has a webview integrated in Podman Desktop
     * We need to initialize and configure it properly
     */
    this.#panel = await initWebview(this.#extensionContext.extensionUri);
    this.#extensionContext.subscriptions.push(this.#panel);
    this.#panel.onDidChangeViewState((e: WebviewPanelOnDidChangeViewStateEvent) => {
      this.#telemetry?.logUsage(e.webviewPanel.visible ? 'opened' : 'closed');
    });

    /**
     * The RpcExtension handle the communication channels between the frontend and the backend
     */
    this.#rpcExtension = new RpcExtension(this.#panel.webview);
    this.#rpcExtension.init();
    this.#extensionContext.subscriptions.push(this.#rpcExtension);

    /**
     * The navigation registry is used
     * to register and managed the routes of the extension
     */
    this.#navigationRegistry = new NavigationRegistry(this.#panel, this.#rpcExtension);
    this.#navigationRegistry.init();
    this.#extensionContext.subscriptions.push(this.#navigationRegistry);

    /**
     * Cancellation token registry store the tokens used to cancel a task
     */
    this.#cancellationTokenRegistry = new CancellationTokenRegistry();
    this.#extensionContext.subscriptions.push(this.#cancellationTokenRegistry);

    /**
     * The configuration registry manage the extension preferences/settings
     */
    this.#configurationRegistry = new ConfigurationRegistry(this.#rpcExtension, appUserDirectory);
    this.#configurationRegistry?.init();
    this.#extensionContext.subscriptions.push(this.#configurationRegistry);

    /**
     * The container registry handle the events linked to containers (start, remove, die...)
     */
    this.#containerRegistry = new ContainerRegistry();
    this.#containerRegistry.init();
    this.#extensionContext.subscriptions.push(this.#containerRegistry);

    /**
     * GitManager is used for cloning, pulling etc. recipes repositories
     */
    const gitManager = new GitManager();

    /**
     * The podman connection class is responsible for podman machine events (start/stop)
     */
    this.#podmanConnection = new PodmanConnection(this.#rpcExtension);
    this.#podmanConnection.init();
    this.#extensionContext.subscriptions.push(this.#podmanConnection);

    /**
     * The task registry store the tasks
     */
    this.#taskRegistry = new TaskRegistry(this.#rpcExtension);
    this.#extensionContext.subscriptions.push(this.#taskRegistry);

    /**
     * Create catalog manager, responsible for loading the catalog files and watching for changes
     */
    this.#catalogManager = new CatalogManager(this.#rpcExtension, appUserDirectory);
    await this.#catalogManager.init();

    /**
     * The builder manager is handling the building tasks, create corresponding tasks
     * through the task registry and cancellation.
     */
    this.#builderManager = new BuilderManager(this.#taskRegistry);
    this.#extensionContext.subscriptions.push(this.#builderManager);

    /**
     * The pod manager is a class responsible for managing the Pods
     */
    this.#podManager = new PodManager();
    this.#podManager.init();
    this.#extensionContext.subscriptions.push(this.#podManager);

    /**
     * The ModelManager role is to download and
     */
    const modelHandlerRegistry = new ModelHandlerRegistry(this.#rpcExtension);
    this.#modelsManager = new ModelsManager(
      this.#rpcExtension,
      this.#catalogManager,
      this.#telemetry,
      this.#taskRegistry,
      this.#cancellationTokenRegistry,
      this.#podmanConnection,
      this.#configurationRegistry,
      modelHandlerRegistry,
    );
    const urlModelHandler = new URLModelHandler(
      this.#modelsManager,
      this.#configurationRegistry.getExtensionConfiguration().modelsPath,
    );
    this.#extensionContext.subscriptions.push(urlModelHandler);
    this.#extensionContext.subscriptions.push(modelHandlerRegistry.register(urlModelHandler));
    const hfModelHandler = new HuggingFaceModelHandler(this.#modelsManager);
    this.#extensionContext.subscriptions.push(hfModelHandler);
    this.#extensionContext.subscriptions.push(modelHandlerRegistry.register(hfModelHandler));
    await this.#modelsManager.init();
    this.#extensionContext.subscriptions.push(this.#modelsManager);

    /**
     * The LocalRepositoryRegistry store and watch for recipes repository locally and expose it.
     */
    this.#localRepositoryRegistry = new LocalRepositoryRegistry(
      this.#rpcExtension,
      appUserDirectory,
      this.#catalogManager,
    );
    this.#localRepositoryRegistry.init();
    this.#extensionContext.subscriptions.push(this.#localRepositoryRegistry);

    /**
     * GPUManager is a class responsible for detecting and storing the GPU specs
     */
    this.#gpuManager = new GPUManager(this.#rpcExtension);
    this.#extensionContext.subscriptions.push(this.#gpuManager);

    /**
     * The Inference Provider registry stores all the InferenceProvider (aka backend) which
     * can be used to create InferenceServers
     */
    this.#inferenceProviderRegistry = new InferenceProviderRegistry(this.#rpcExtension);
    this.#extensionContext.subscriptions.push(
      this.#inferenceProviderRegistry.register(
        new LlamaCppPython(this.#taskRegistry, this.#podmanConnection, this.#gpuManager, this.#configurationRegistry),
      ),
    );
    this.#extensionContext.subscriptions.push(
      this.#inferenceProviderRegistry.register(new WhisperCpp(this.#taskRegistry, this.#podmanConnection)),
    );
    if (os.arch() === 'x64') {
      this.#extensionContext.subscriptions.push(
        this.#inferenceProviderRegistry.register(
          new OpenVINO(this.#taskRegistry, this.#podmanConnection, this.#modelsManager, this.#configurationRegistry),
        ),
      );
    }

    /**
     * The inference manager create, stop, manage Inference servers
     */
    this.#inferenceManager = new InferenceManager(
      this.#rpcExtension,
      this.#containerRegistry,
      this.#podmanConnection,
      this.#modelsManager,
      this.#telemetry,
      this.#taskRegistry,
      this.#inferenceProviderRegistry,
      this.#catalogManager,
    );
    this.#inferenceManager.init();
    this.#extensionContext.subscriptions.push(this.#inferenceManager);

    /** The InstructLab tuning sessions manager */
    this.#instructlabManager = new InstructlabManager(
      appUserDirectory,
      this.#taskRegistry,
      this.#podmanConnection,
      this.#containerRegistry,
      this.#telemetry,
    );
    this.#instructlabManager.init();
    this.#extensionContext.subscriptions.push(this.#instructlabManager);

    /** The Llama Stack manager */
    this.#llamaStackManager = new LlamaStackManager(
      appUserDirectory,
      this.#taskRegistry,
      this.#podmanConnection,
      this.#containerRegistry,
      this.#configurationRegistry,
      this.#telemetry,
      this.#modelsManager,
    );
    this.#extensionContext.subscriptions.push(this.#llamaStackManager);
    this.#llamaStackManager.init();

    /**
     * The recipe manage offer some andy methods to manage recipes, build get images etc.
     */
    this.#recipeManager = new RecipeManager(
      appUserDirectory,
      gitManager,
      this.#taskRegistry,
      this.#builderManager,
      this.#localRepositoryRegistry,
      this.#inferenceManager,
    );
    this.#recipeManager.init();
    this.#extensionContext.subscriptions.push(this.#recipeManager);

    /**
     * The application manager is managing the Recipes
     */
    this.#applicationManager = new ApplicationManager(
      this.#taskRegistry,
      this.#rpcExtension,
      this.#podmanConnection,
      this.#catalogManager,
      this.#modelsManager,
      this.#telemetry,
      this.#podManager,
      this.#recipeManager,
      this.#llamaStackManager,
    );
    this.#applicationManager.init();
    this.#extensionContext.subscriptions.push(this.#applicationManager);

    this.#mcpServerManager = new McpServerManager(this.#rpcExtension, appUserDirectory);
    this.#mcpServerManager.init();
    this.#extensionContext.subscriptions.push(this.#mcpServerManager);

    /**
     * PlaygroundV2Manager handle the conversations of the Playground by using the InferenceServer available
     */
    this.#playgroundManager = new PlaygroundV2Manager(
      this.#rpcExtension,
      this.#inferenceManager,
      this.#taskRegistry,
      this.#telemetry,
      this.#cancellationTokenRegistry,
      this.#mcpServerManager,
    );
    this.#extensionContext.subscriptions.push(this.#playgroundManager);

    /**
     * The snippet manager provide code snippet used in the
     * InferenceServer details page
     */
    this.#snippetManager = new SnippetManager(this.#rpcExtension, this.#telemetry);
    this.#snippetManager.init();

    /**
     * The StudioApiImpl is the implementation of our API between backend and frontend
     */
    this.#studioApi = new StudioApiImpl(
      this.#applicationManager,
      this.#catalogManager,
      this.#modelsManager,
      this.#telemetry,
      this.#localRepositoryRegistry,
      this.#taskRegistry,
      this.#inferenceManager,
      this.#playgroundManager,
      this.#snippetManager,
      this.#cancellationTokenRegistry,
      this.#configurationRegistry,
      this.#recipeManager,
      this.#podmanConnection,
      this.#navigationRegistry,
    );
    // Register the instance
    this.#rpcExtension.registerInstance<StudioAPI, StudioApiImpl>(STUDIO_API_CHANNEL, this.#studioApi);

    const apiServer = new ApiServer(
      this.#extensionContext,
      this.#modelsManager,
      this.#catalogManager,
      this.#inferenceManager,
      this.#configurationRegistry,
      this.#containerRegistry,
    );
    await apiServer.init();
    this.#extensionContext.subscriptions.push(apiServer);

    this.#instructlabApi = new InstructlabApiImpl(this.#instructlabManager);
    // Register the instance
    this.#rpcExtension.registerInstance<InstructlabAPI, InstructlabApiImpl>(
      INSTRUCTLAB_API_CHANNEL,
      this.#instructlabApi,
    );

    this.#llamaStackApi = new LlamaStackApiImpl(this.#llamaStackManager);
    // Register the instance
    this.#rpcExtension.registerInstance<LlamaStackAPI, LlamaStackApiImpl>(LLAMA_STACK_API_CHANNEL, this.#llamaStackApi);
  }

  public async deactivate(): Promise<void> {
    console.log('stopping AI Lab extension');
    this.#telemetry?.logUsage('stop');
  }
}
