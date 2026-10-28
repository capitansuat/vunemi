import type {TaskRecord} from '@vunemi/agent-core';
import {t} from '@vunemi/i18n';

/** A finite native authority cannot become an ordinary model recovery task. */
export function assertModelRecoveryAllowed(task:TaskRecord|undefined):void {
 if(task?.executionMode==='native-recipe'||task?.operations.some(operation=>operation.tool==='native_recipe_textedit_append_save'))throw Error(t('nativeRecipes.noResume'));
}
